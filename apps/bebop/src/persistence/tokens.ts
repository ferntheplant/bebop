// Named bearer tokens, stored hashed (`docs/capabilities/14-the-security-model.md`).
//
// The plaintext exists in exactly one place: the `POST /api/tokens` response. Postgres holds
// only a SHA-256 hash, so a database read cannot recover a working credential. Authentication
// looks a presented token up by that hash, which is a single indexed equality — there is no
// per-row comparison loop and therefore no need for a slow KDF: these are 256-bit random
// secrets, not user-chosen passwords, so there is nothing to brute-force offline.

import { createHash } from "node:crypto";

import type { ApiTokenId, ApiTokenName, ApiTokenSecret, ApiTokenSummary, Timestamp } from "@bebop/contracts";
import { ApiTokenId as ApiTokenIdSchema, ApiTokenName as ApiTokenNameSchema } from "@bebop/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql";

import { timestampToIso } from "#src/domain/identity.ts";
import type { Row } from "#src/persistence/rows.ts";
import { optionalTimestamp, text, timestamp } from "#src/persistence/rows.ts";

/** The lookup key for a presented token. Never stored alongside the plaintext. */
export function hashApiToken(secret: ApiTokenSecret): string {
  return createHash("sha256").update(secret).digest("hex");
}

const decodeTokenId = Schema.decodeUnknownSync(ApiTokenIdSchema);
const decodeTokenName = Schema.decodeUnknownSync(ApiTokenNameSchema);

function toSummary(row: Row): ApiTokenSummary {
  const revokedAt = optionalTimestamp(row, "revoked_at");
  const lastUsedAt = optionalTimestamp(row, "last_used_at");
  return {
    tokenId: decodeTokenId(text(row, "token_id")),
    name: decodeTokenName(text(row, "name")),
    createdAt: timestamp(row, "created_at"),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

export interface AuthenticatedToken {
  readonly tokenId: ApiTokenId;
  readonly name: ApiTokenName;
}

export interface ApiTokenRepositoryService {
  readonly create: (options: {
    readonly tokenId: ApiTokenId;
    readonly name: ApiTokenName;
    readonly secret: ApiTokenSecret;
    readonly createdAt: Timestamp;
  }) => Effect.Effect<ApiTokenSummary, SqlError.SqlError>;
  /** Seeds the first token only while the table is empty. */
  readonly bootstrap: (options: {
    readonly tokenId: ApiTokenId;
    readonly name: ApiTokenName;
    readonly secret: ApiTokenSecret;
    readonly createdAt: Timestamp;
  }) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly hasAny: Effect.Effect<boolean, SqlError.SqlError>;
  readonly list: Effect.Effect<ReadonlyArray<ApiTokenSummary>, SqlError.SqlError>;
  readonly revoke: (options: {
    readonly tokenId: ApiTokenId;
    readonly revokedAt: Timestamp;
  }) => Effect.Effect<ApiTokenSummary | null, SqlError.SqlError>;
  /**
   * Resolves a presented secret to the token that authorises the request, recording use.
   *
   * A revoked token resolves to `null`: revocation must take effect on the next request,
   * not at the next restart (`docs/capabilities/14-the-security-model.md`, "individually revocable").
   */
  readonly authenticate: (options: {
    readonly secret: ApiTokenSecret;
    readonly usedAt: Timestamp;
  }) => Effect.Effect<AuthenticatedToken | null, SqlError.SqlError>;
}

export class ApiTokenRepository extends Context.Service<ApiTokenRepository, ApiTokenRepositoryService>()(
  "ApiTokenRepository",
) {}

export const ApiTokenRepositoryLayer: Layer.Layer<ApiTokenRepository, never, SqlClient.SqlClient> = Layer.effect(
  ApiTokenRepository,
)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      create: ({ createdAt, name, secret, tokenId }) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO api_tokens (token_id, name, token_hash, created_at)
            VALUES (${tokenId}, ${name}, ${hashApiToken(secret)}, ${timestampToIso(createdAt)})
          `;
          return { tokenId, name, createdAt };
        }),

      bootstrap: ({ createdAt, name, secret, tokenId }) =>
        sql`
          INSERT INTO api_tokens (token_id, name, token_hash, created_at)
          SELECT ${tokenId}, ${name}, ${hashApiToken(secret)}, ${timestampToIso(createdAt)}
          WHERE NOT EXISTS (SELECT 1 FROM api_tokens)
          ON CONFLICT DO NOTHING
          RETURNING token_id
        `.pipe(Effect.map((rows) => rows.length === 1)),

      hasAny: sql`SELECT EXISTS (SELECT 1 FROM api_tokens) AS present`.pipe(
        Effect.map((rows) => rows[0]?.["present"] === true),
      ),

      list: sql`
        SELECT token_id, name, created_at, last_used_at, revoked_at
        FROM api_tokens
        ORDER BY created_at DESC, token_id DESC
      `.pipe(Effect.map((rows) => rows.map((row) => toSummary(row as Row)))),

      revoke: ({ revokedAt, tokenId }) =>
        sql`
          UPDATE api_tokens
          SET revoked_at = coalesce(revoked_at, ${timestampToIso(revokedAt)})
          WHERE token_id = ${tokenId}
          RETURNING token_id, name, created_at, last_used_at, revoked_at
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toSummary(rows[0] as Row)))),

      authenticate: ({ secret, usedAt }) =>
        sql`
          UPDATE api_tokens
          SET last_used_at = ${timestampToIso(usedAt)}
          WHERE token_hash = ${hashApiToken(secret)} AND revoked_at IS NULL
          RETURNING token_id, name
        `.pipe(
          Effect.map((rows) => {
            const row = rows[0] as Row | undefined;
            return row === undefined
              ? null
              : { tokenId: decodeTokenId(text(row, "token_id")), name: decodeTokenName(text(row, "name")) };
          }),
        ),
    };
  }),
);
