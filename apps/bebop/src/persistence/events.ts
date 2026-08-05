// The client-visible bounty event log behind `GET /api/bounties/:id/events`.
//
// Cursors are per bounty and dense, which is what makes `Last-Event-ID` replay exact: a
// client that says "I have 7" is asking for 8, 9, 10 and nothing else. Density is enforced
// by allocating the cursor under a per-bounty advisory lock rather than by retrying a
// primary-key conflict — a conflict inside an outer transaction would abort the whole
// transaction, and appends here routinely run inside one.

import type { BountyEventCursor, BountyEventEnvelope, BountyId, Timestamp } from "@bebop/contracts";
import { BountyEventEnvelope as BountyEventEnvelopeSchema } from "@bebop/contracts";
import { PgClient } from "@effect/sql-pg";
import type { Stream } from "effect";
import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";

import { timestampToIso } from "#src/domain/identity.ts";
import type { Row } from "#src/persistence/rows.ts";
import { bigintNumber, json, jsonbParameter, timestamp } from "#src/persistence/rows.ts";

type BountyPublicEvent = BountyEventEnvelope["event"];

/**
 * The Postgres NOTIFY channel a live SSE subscriber listens on.
 *
 * Events are appended by whichever process observed them — the API's Swordfish gateway, or
 * the worker's freshness sweep — so an in-process bus would silently drop half of them.
 */
const bountyEventChannel = "bebop_bounty_events";

const decodeEnvelope = Schema.decodeUnknownSync(BountyEventEnvelopeSchema);
const encodeEnvelopeEvent = Schema.encodeUnknownSync(Schema.Struct({ event: BountyEventEnvelopeSchema.fields.event }));

function toEnvelope(row: Row): BountyEventEnvelope {
  return decodeEnvelope({
    cursor: bigintNumber(row, "cursor"),
    bountyId: row["bounty_id"],
    occurredAt: Schema.encodeSync(Schema.Struct({ at: BountyEventEnvelopeSchema.fields.occurredAt }))({
      at: timestamp(row, "occurred_at"),
    }).at,
    event: (json(row, "payload") as { readonly event: unknown }).event,
  });
}

interface BountyEventRepositoryService {
  /** Appends one event and returns it with the cursor it was assigned. */
  readonly append: (options: {
    readonly bountyId: BountyId;
    readonly occurredAt: Timestamp;
    readonly event: BountyPublicEvent;
  }) => Effect.Effect<BountyEventEnvelope, SqlError.SqlError>;
  /** Reads a page of events strictly after `afterCursor`, in cursor order. */
  readonly read: (options: {
    readonly bountyId: BountyId;
    readonly afterCursor: number;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<BountyEventEnvelope>, SqlError.SqlError>;
  readonly latestCursor: (bountyId: BountyId) => Effect.Effect<BountyEventCursor, SqlError.SqlError>;
  /** Wakes live subscribers. Best effort: the poll interval is the correctness floor. */
  readonly notifyAppended: (bountyId: BountyId) => Effect.Effect<void, SqlError.SqlError>;
  /** The stream of bounty IDs that have new events, as announced by any Bebop process. */
  readonly appended: Stream.Stream<string, SqlError.SqlError>;
}

export class BountyEventRepository extends Context.Service<BountyEventRepository, BountyEventRepositoryService>()(
  "BountyEventRepository",
) {}

/**
 * Serialises cursor allocation for one bounty inside the current transaction.
 *
 * The lock is released at commit or rollback, so nothing here can leak a held lock; and
 * because two different bounties only ever collide by hash, the cost of a collision is a
 * short wait rather than a wrong answer.
 */
function lockBounty(sql: PgClient.PgClient, bountyId: BountyId) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${bountyId})::bigint)`;
}

export const BountyEventRepositoryLayer: Layer.Layer<BountyEventRepository, never, PgClient.PgClient> = Layer.effect(
  BountyEventRepository,
)(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const append: BountyEventRepositoryService["append"] = ({ bountyId, event, occurredAt }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* lockBounty(sql, bountyId);
            const rows = yield* sql`
              INSERT INTO bounty_events (bounty_id, cursor, occurred_at, payload)
              SELECT
                ${bountyId},
                coalesce(max(cursor), 0) + 1,
                ${timestampToIso(occurredAt)},
                ${jsonbParameter(encodeEnvelopeEvent({ event }))}::jsonb
              FROM bounty_events
              WHERE bounty_id = ${bountyId}
              RETURNING bounty_id, cursor, occurred_at, payload
            `;
            const row = rows[0];
            if (row === undefined) {
              return yield* Effect.die(new Error(`Appending a bounty event for ${bountyId} returned no row`));
            }
            return toEnvelope(row as Row);
          }),
        )
        .pipe(Effect.tap(() => notifyAppended(bountyId)));

    const notifyAppended: BountyEventRepositoryService["notifyAppended"] = (bountyId) =>
      sql.notify(bountyEventChannel, bountyId);

    return {
      append,
      notifyAppended,

      read: ({ afterCursor, bountyId, limit }) =>
        sql`
          SELECT bounty_id, cursor, occurred_at, payload
          FROM bounty_events
          WHERE bounty_id = ${bountyId} AND cursor > ${String(afterCursor)}::bigint
          ORDER BY cursor
          LIMIT ${limit}
        `.pipe(Effect.map((rows) => rows.map((row) => toEnvelope(row as Row)))),

      latestCursor: (bountyId) =>
        sql`SELECT coalesce(max(cursor), 0) AS cursor FROM bounty_events WHERE bounty_id = ${bountyId}`.pipe(
          Effect.map((rows) => bigintNumber(rows[0] as Row, "cursor") as BountyEventCursor),
        ),

      appended: sql.listen(bountyEventChannel),
    };
  }),
);
