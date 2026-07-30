// The durable Swordfish projection and the accepted-event log behind it (SPEC section 9.3).
//
// Two things are persisted, and they answer different questions:
//
// - `swordfish_events` is the record of what Swordfish said, with the fingerprint computed
//   at the protocol boundary. It is the audit trail and the repair source.
// - `swordfish_projections` is the conclusion, so a reconnect does not have to replay a
//   bounty's whole history to know its stage.

import type {
  BountyId,
  EventMessage,
  EventSequence,
  SwordfishFreshnessStatus,
  Timestamp,
  VmId,
} from "@bebop/contracts";
import {
  ConnectionId as ConnectionIdSchema,
  EventMessage as EventMessageSchema,
  VmId as VmIdSchema,
} from "@bebop/contracts";
import { PgClient } from "@effect/sql-pg";
import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";

import { timestampToIso } from "#src/domain/identity.ts";
import {
  decodeWorkflowSnapshot,
  encodeWorkflowSnapshot,
  fromWorkflowSnapshot,
  toWorkflowSnapshot,
} from "#src/domain/projection-snapshot.ts";
import type { BebopSwordfishProjection } from "#src/domain/swordfish-projection.ts";
import { makeInitialBebopSwordfishProjection } from "#src/domain/swordfish-projection.ts";
import type { Row } from "#src/persistence/rows.ts";
import { bigintNumber, json, jsonbParameter, optionalText, optionalTimestamp, text } from "#src/persistence/rows.ts";

const decodeVmId = Schema.decodeUnknownSync(VmIdSchema);
const decodeConnectionId = Schema.decodeUnknownSync(ConnectionIdSchema);
const encodeEventMessage = Schema.encodeUnknownSync(EventMessageSchema);

const freshnessStatuses = ["never_connected", "connected", "disconnected", "stale"] as const;

function toProjection(row: Row): BebopSwordfishProjection {
  const snapshot = fromWorkflowSnapshot(decodeWorkflowSnapshot(json(row, "snapshot")));
  const connectionIdText = optionalText(row, "connection_id");
  const lastObservedAt = optionalTimestamp(row, "last_observed_at");
  const status = text(row, "freshness");
  if (!freshnessStatuses.includes(status as SwordfishFreshnessStatus)) {
    throw new Error(`Unknown Swordfish freshness "${status}"`);
  }
  const freshness =
    status === "never_connected" || lastObservedAt === undefined
      ? ({ status: "never_connected" } as const)
      : ({ status: status as "connected" | "disconnected" | "stale", lastObservedAt } as const);

  return {
    ...snapshot,
    bountyId: text(row, "bounty_id") as BountyId,
    vmId: decodeVmId(text(row, "vm_id")),
    lastProducedSequence: bigintNumber(row, "last_produced_sequence") as EventSequence,
    connectionId: connectionIdText === undefined ? null : decodeConnectionId(connectionIdText),
    stage: snapshot.stage,
    freshness,
  };
}

export interface AcceptedSwordfishEvent {
  readonly bountyId: BountyId;
  readonly message: EventMessage;
  /**
   * Computed once, over the decoded message, at the moment it arrived.
   *
   * Never recomputed from `payload`: `jsonb` reorders keys (`spikes/persistence`, PG4b), so
   * a re-derived fingerprint would differ from the original and make every legitimate replay
   * look like a conflict.
   */
  readonly fingerprint: string;
  readonly receivedAt: Timestamp;
}

export interface SwordfishProjectionRepositoryService {
  /** Loads the projection, or an empty one bound to this bounty and VM. */
  readonly load: (options: {
    readonly bountyId: BountyId;
    readonly vmId: VmId;
  }) => Effect.Effect<BebopSwordfishProjection, SqlError.SqlError>;
  readonly loadIfPresent: (bountyId: BountyId) => Effect.Effect<BebopSwordfishProjection | null, SqlError.SqlError>;
  readonly save: (options: {
    readonly projection: BebopSwordfishProjection;
    readonly at: Timestamp;
  }) => Effect.Effect<void, SqlError.SqlError>;
  readonly recordEvent: (event: AcceptedSwordfishEvent) => Effect.Effect<void, SqlError.SqlError>;
  /** Every projection currently believed connected whose last traffic predates `before`. */
  readonly staleCandidates: (options: {
    readonly before: Timestamp;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<BebopSwordfishProjection>, SqlError.SqlError>;
  /** Projections still holding a live connection, used to reconcile an API restart. */
  readonly connectedProjections: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<BebopSwordfishProjection>, SqlError.SqlError>;
}

export class SwordfishProjectionRepository extends Context.Service<
  SwordfishProjectionRepository,
  SwordfishProjectionRepositoryService
>()("SwordfishProjectionRepository") {}

const projectionColumns = `bounty_id, vm_id, connection_id, freshness, last_observed_at, stage,
  last_produced_sequence, last_applied_sequence, snapshot, updated_at`;

export const SwordfishProjectionRepositoryLayer: Layer.Layer<SwordfishProjectionRepository, never, PgClient.PgClient> =
  Layer.effect(SwordfishProjectionRepository)(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const loadIfPresent: SwordfishProjectionRepositoryService["loadIfPresent"] = (bountyId) =>
        sql`SELECT ${sql.literal(projectionColumns)} FROM swordfish_projections WHERE bounty_id = ${bountyId}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : toProjection(rows[0] as Row))),
        );

      return {
        loadIfPresent,

        load: ({ bountyId, vmId }) =>
          loadIfPresent(bountyId).pipe(
            Effect.map((projection) => projection ?? makeInitialBebopSwordfishProjection(bountyId, vmId)),
          ),

        save: ({ at, projection }) =>
          sql`
          INSERT INTO swordfish_projections (
            bounty_id, vm_id, connection_id, freshness, last_observed_at, stage,
            last_produced_sequence, last_applied_sequence, snapshot, updated_at
          ) VALUES (
            ${projection.bountyId}, ${projection.vmId}, ${projection.connectionId},
            ${projection.freshness.status},
            ${projection.freshness.status === "never_connected" ? null : timestampToIso(projection.freshness.lastObservedAt)},
            ${projection.stage},
            ${String(projection.lastProducedSequence)}::bigint,
            ${String(projection.lastAppliedSequence)}::bigint,
            ${jsonbParameter(encodeWorkflowSnapshot(toWorkflowSnapshot(projection)))}::jsonb,
            ${timestampToIso(at)}
          )
          ON CONFLICT (bounty_id) DO UPDATE SET
            vm_id = excluded.vm_id,
            connection_id = excluded.connection_id,
            freshness = excluded.freshness,
            last_observed_at = excluded.last_observed_at,
            stage = excluded.stage,
            last_produced_sequence = excluded.last_produced_sequence,
            last_applied_sequence = excluded.last_applied_sequence,
            snapshot = excluded.snapshot,
            updated_at = excluded.updated_at
        `.pipe(Effect.asVoid),

        recordEvent: ({ bountyId, fingerprint, message, receivedAt }) =>
          sql`
          INSERT INTO swordfish_events (bounty_id, sequence, vm_id, occurred_at, received_at, fingerprint, payload)
          VALUES (
            ${bountyId}, ${String(message.sequence)}::bigint, ${message.vmId},
            ${timestampToIso(message.occurredAt)}, ${timestampToIso(receivedAt)}, ${fingerprint},
            ${jsonbParameter(encodeEventMessage(message))}::jsonb
          )
          ON CONFLICT (bounty_id, sequence) DO NOTHING
        `.pipe(Effect.asVoid),

        staleCandidates: ({ before, limit }) =>
          sql`
          SELECT ${sql.literal(projectionColumns)} FROM swordfish_projections
          WHERE freshness = 'connected' AND last_observed_at < ${timestampToIso(before)}
          ORDER BY last_observed_at
          LIMIT ${limit}
        `.pipe(Effect.map((rows) => rows.map((row) => toProjection(row as Row)))),

        connectedProjections: (limit) =>
          sql`
          SELECT ${sql.literal(projectionColumns)} FROM swordfish_projections
          WHERE connection_id IS NOT NULL
          ORDER BY updated_at
          LIMIT ${limit}
        `.pipe(Effect.map((rows) => rows.map((row) => toProjection(row as Row)))),
      };
    }),
  );
