// Durable background work for `bebop-worker` (SPEC section 25).
//
// The API never provisions or destroys inline. It writes durable intent — a job row, in the
// same transaction as the state change that justified it — and the worker performs the
// externally visible operation. That ordering is PLAN section 4's rule that "Bebop and
// Swordfish write durable intent before performing externally visible side effects", and it
// is what makes a crash mid-provision recoverable rather than a lost VM.
//
// Claiming uses `FOR UPDATE SKIP LOCKED`, so more than one worker is safe without any of
// them waiting on each other.

import type { BountyId, Timestamp } from "@bebop/contracts";
import { PgClient } from "@effect/sql-pg";
import { Context, Duration, Effect, Layer } from "effect";
import type { SqlError } from "effect/unstable/sql";

import { timestampToIso } from "#src/domain/identity.ts";
import type { Row } from "#src/persistence/rows.ts";
import { integer, json, jsonbParameter, oneOf, optionalText, text } from "#src/persistence/rows.ts";

export const lifecycleJobKinds = ["provision", "destroy"] as const;
export type LifecycleJobKind = (typeof lifecycleJobKinds)[number];

export const lifecycleJobStatuses = ["pending", "running", "succeeded", "failed"] as const;
export type LifecycleJobStatus = (typeof lifecycleJobStatuses)[number];

export interface LifecycleJob {
  readonly jobId: string;
  readonly dedupeKey: string;
  readonly bountyId: BountyId;
  readonly kind: LifecycleJobKind;
  readonly payload: unknown;
  readonly status: LifecycleJobStatus;
  readonly attempts: number;
  readonly lastError?: string;
}

/**
 * How many times a job is retried before it is parked as `failed`.
 *
 * Parking rather than retrying forever is deliberate: a bounty whose provisioning cannot
 * succeed should surface as a failed bounty a human can see, not as an invisible loop
 * burning a connection every second.
 */
export const maxJobAttempts = 5;

function toJob(row: Row): LifecycleJob {
  const lastError = optionalText(row, "last_error");
  return {
    jobId: text(row, "job_id"),
    dedupeKey: text(row, "dedupe_key"),
    bountyId: text(row, "bounty_id") as BountyId,
    kind: oneOf(row, "kind", lifecycleJobKinds),
    payload: json(row, "payload"),
    status: oneOf(row, "status", lifecycleJobStatuses),
    attempts: integer(row, "attempts"),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

const jobColumns = `job_id, dedupe_key, bounty_id, kind, payload, status, attempts, run_after, last_error`;

export interface LifecycleJobRepositoryService {
  /** Enqueues work, or returns the existing job for a repeated `dedupeKey`. */
  readonly enqueue: (options: {
    readonly jobId: string;
    readonly dedupeKey: string;
    readonly bountyId: BountyId;
    readonly kind: LifecycleJobKind;
    readonly payload: unknown;
    readonly at: Timestamp;
  }) => Effect.Effect<LifecycleJob, SqlError.SqlError>;
  /** Claims one runnable job for this worker, or `null` when there is nothing to do. */
  readonly claim: (options: {
    readonly workerId: string;
    readonly at: Timestamp;
  }) => Effect.Effect<LifecycleJob | null, SqlError.SqlError>;
  readonly complete: (options: {
    readonly jobId: string;
    readonly at: Timestamp;
  }) => Effect.Effect<void, SqlError.SqlError>;
  /** Releases a failed job for another attempt, or parks it once attempts run out. */
  readonly fail: (options: {
    readonly jobId: string;
    readonly at: Timestamp;
    readonly error: string;
    readonly retryAfter: Duration.Duration;
  }) => Effect.Effect<LifecycleJobStatus, SqlError.SqlError>;
  readonly get: (jobId: string) => Effect.Effect<LifecycleJob | null, SqlError.SqlError>;
  readonly forBounty: (bountyId: BountyId) => Effect.Effect<ReadonlyArray<LifecycleJob>, SqlError.SqlError>;
}

export class LifecycleJobRepository extends Context.Service<LifecycleJobRepository, LifecycleJobRepositoryService>()(
  "LifecycleJobRepository",
) {}

export const LifecycleJobRepositoryLayer: Layer.Layer<LifecycleJobRepository, never, PgClient.PgClient> = Layer.effect(
  LifecycleJobRepository,
)(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    return {
      enqueue: ({ at, bountyId, dedupeKey, jobId, kind, payload }) =>
        sql`
          INSERT INTO lifecycle_jobs (
            job_id, dedupe_key, bounty_id, kind, payload, status, attempts, run_after, created_at, updated_at
          ) VALUES (
            ${jobId}, ${dedupeKey}, ${bountyId}, ${kind}, ${jsonbParameter(payload)}::jsonb, 'pending', 0,
            ${timestampToIso(at)}, ${timestampToIso(at)}, ${timestampToIso(at)}
          )
          ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key = lifecycle_jobs.dedupe_key
          RETURNING ${sql.literal(jobColumns)}
        `.pipe(Effect.map((rows) => toJob(rows[0] as Row))),

      claim: ({ at, workerId }) =>
        sql`
          UPDATE lifecycle_jobs SET
            status = 'running',
            attempts = attempts + 1,
            locked_by = ${workerId},
            locked_at = ${timestampToIso(at)},
            updated_at = ${timestampToIso(at)}
          WHERE job_id = (
            SELECT job_id FROM lifecycle_jobs
            WHERE status = 'pending' AND run_after <= ${timestampToIso(at)}
            ORDER BY run_after, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING ${sql.literal(jobColumns)}
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toJob(rows[0] as Row)))),

      complete: ({ at, jobId }) =>
        sql`
          UPDATE lifecycle_jobs
          SET status = 'succeeded', locked_by = NULL, locked_at = NULL, last_error = NULL,
              updated_at = ${timestampToIso(at)}
          WHERE job_id = ${jobId}
        `.pipe(Effect.asVoid),

      fail: ({ at, error, jobId, retryAfter }) =>
        sql`
          UPDATE lifecycle_jobs
          SET status = CASE WHEN attempts >= ${maxJobAttempts} THEN 'failed' ELSE 'pending' END,
              locked_by = NULL,
              locked_at = NULL,
              last_error = ${error},
              run_after = ${new Date(Date.parse(timestampToIso(at)) + Duration.toMillis(retryAfter)).toISOString()},
              updated_at = ${timestampToIso(at)}
          WHERE job_id = ${jobId}
          RETURNING status
        `.pipe(Effect.map((rows) => oneOf(rows[0] as Row, "status", lifecycleJobStatuses))),

      get: (jobId) =>
        sql`SELECT ${sql.literal(jobColumns)} FROM lifecycle_jobs WHERE job_id = ${jobId}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : toJob(rows[0] as Row))),
        ),

      forBounty: (bountyId) =>
        sql`SELECT ${sql.literal(jobColumns)} FROM lifecycle_jobs WHERE bounty_id = ${bountyId} ORDER BY created_at`.pipe(
          Effect.map((rows) => rows.map((row) => toJob(row as Row))),
        ),
    };
  }),
);
