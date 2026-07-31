// Idempotency keys ("Postgres for bebop, SQLite for Swordfish" (ADR 0008)).
//
// Creating the same bounty request with one idempotency key must not create duplicate
// lifecycle work. Two things make that true:
//
// - the key row is inserted in the **same transaction** as the bounty and its provisioning
//   job, so a crash between them is impossible; and
// - the primary key on `(scope, idempotency_key)` makes two concurrent identical requests a
//   race that Postgres settles — the loser sees a unique violation and re-reads the winner's
//   result instead of creating a second bounty.
//
// The stored fingerprint is what separates "the client retried" from "the client reused a
// key for different work". The second is a conflict, not an alias.

import { createHash } from "node:crypto";

import type { BountyId, IdempotencyKey, Timestamp } from "@bebop/contracts";
import { Context, Effect, Layer } from "effect";
import type { SqlError } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql";

import { timestampToIso } from "#src/domain/identity.ts";
import type { Row } from "#src/persistence/rows.ts";
import { optionalText, text } from "#src/persistence/rows.ts";

export type IdempotencyScope = "create_bounty";

export interface IdempotencyRecord {
  readonly scope: IdempotencyScope;
  readonly key: IdempotencyKey;
  readonly requestFingerprint: string;
  readonly bountyId: BountyId | null;
}

/** A stable fingerprint of a request body, independent of key order. */
export function fingerprintRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface IdempotencyRepositoryService {
  readonly find: (options: {
    readonly scope: IdempotencyScope;
    readonly key: IdempotencyKey;
  }) => Effect.Effect<IdempotencyRecord | null, SqlError.SqlError>;
  /** Claims a key. Returns `null` when another request already holds it. */
  readonly claim: (options: {
    readonly scope: IdempotencyScope;
    readonly key: IdempotencyKey;
    readonly requestFingerprint: string;
    readonly bountyId: BountyId;
    readonly createdAt: Timestamp;
  }) => Effect.Effect<IdempotencyRecord | null, SqlError.SqlError>;
}

export class IdempotencyRepository extends Context.Service<IdempotencyRepository, IdempotencyRepositoryService>()(
  "IdempotencyRepository",
) {}

function toRecord(row: Row): IdempotencyRecord {
  const bountyId = optionalText(row, "bounty_id");
  return {
    scope: text(row, "scope") as IdempotencyScope,
    key: text(row, "idempotency_key") as IdempotencyKey,
    requestFingerprint: text(row, "request_fingerprint"),
    bountyId: bountyId === undefined ? null : (bountyId as BountyId),
  };
}

export const IdempotencyRepositoryLayer: Layer.Layer<IdempotencyRepository, never, SqlClient.SqlClient> = Layer.effect(
  IdempotencyRepository,
)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      find: ({ key, scope }) =>
        sql`
          SELECT scope, idempotency_key, request_fingerprint, bounty_id
          FROM idempotency_keys WHERE scope = ${scope} AND idempotency_key = ${key}
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0] as Row)))),

      claim: ({ bountyId, createdAt, key, requestFingerprint, scope }) =>
        sql`
          INSERT INTO idempotency_keys (scope, idempotency_key, request_fingerprint, bounty_id, created_at)
          VALUES (${scope}, ${key}, ${requestFingerprint}, ${bountyId}, ${timestampToIso(createdAt)})
          ON CONFLICT (scope, idempotency_key) DO NOTHING
          RETURNING scope, idempotency_key, request_fingerprint, bounty_id
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0] as Row)))),
    };
  }),
);
