// Identifier and secret generation, behind a service.
//
// PLAN section 4: "Time, IDs, process execution, and external clients are Effect services so
// tests can replace them." Bounty IDs appear in branch names (`bounty/<bounty-id>`,
// SPEC section 2) and in every log line, so a test that cannot fix them cannot assert on
// either.

import type { ApiTokenId, ApiTokenSecret, BountyId, CommandId, ConnectionId, Timestamp } from "@bebop/contracts";
import { BountyId as BountyIdSchema } from "@bebop/contracts";
import {
  ApiTokenId as ApiTokenIdSchema,
  ApiTokenSecret as ApiTokenSecretSchema,
  CommandId as CommandIdSchema,
  ConnectionId as ConnectionIdSchema,
  Timestamp as TimestampSchema,
} from "@bebop/contracts";
import { Schema } from "effect";
import { Context, Effect, Layer } from "effect";

/**
 * The prefix on every plaintext API token.
 *
 * It exists so a leaked string is recognisable as a Bebop credential by a secret scanner,
 * and so a user who pastes the wrong value gets a clear error rather than a 401.
 */
export const apiTokenPrefix = "bebop_";

export interface IdentityService {
  readonly bountyId: Effect.Effect<BountyId>;
  readonly commandId: Effect.Effect<CommandId>;
  readonly connectionId: Effect.Effect<ConnectionId>;
  readonly apiTokenId: Effect.Effect<ApiTokenId>;
  readonly apiTokenSecret: Effect.Effect<ApiTokenSecret>;
  readonly jobId: Effect.Effect<string>;
  readonly now: Effect.Effect<Timestamp>;
}

export class Identity extends Context.Service<Identity, IdentityService>()("Identity") {}

const base32Alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A lowercase, sortable, collision-resistant suffix.
 *
 * `BountyId` is constrained to `^[a-z0-9][a-z0-9-]*$` because it becomes a Git ref, so a
 * base64url or uppercase ULID cannot be used verbatim. This is the ULID alphabet: 48 bits of
 * millisecond timestamp keeps identifiers roughly ordered, and 80 bits of randomness makes
 * a collision irrelevant at this scale.
 */
function randomSuffix(millis: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let value = "";
  let timestamp = millis;
  for (let index = 0; index < 10; index += 1) {
    value = `${base32Alphabet[timestamp % 32] ?? "0"}${value}`;
    timestamp = Math.floor(timestamp / 32);
  }
  for (const byte of bytes) {
    value += base32Alphabet[byte % 32] ?? "0";
  }
  return value;
}

function decodeNow(millis: number): Timestamp {
  return Schema.decodeUnknownSync(TimestampSchema)(new Date(millis).toISOString());
}

/** Turns any `Date`-shaped value read back out of Postgres into a canonical `Timestamp`. */
export function timestampFrom(value: Date | string | number): Timestamp {
  const date = value instanceof Date ? value : new Date(value);
  return decodeNow(date.getTime());
}

/** The wire and storage form of a timestamp: canonical UTC to the millisecond. */
export function timestampToIso(timestamp: Timestamp): string {
  return Schema.encodeSync(TimestampSchema)(timestamp);
}

export const IdentityLayer: Layer.Layer<Identity> = Layer.sync(Identity)(() => {
  const suffix = () => Effect.sync(() => randomSuffix(Date.now()));
  return {
    bountyId: suffix().pipe(Effect.map((value) => Schema.decodeUnknownSync(BountyIdSchema)(`bty-${value}`))),
    commandId: suffix().pipe(Effect.map((value) => Schema.decodeUnknownSync(CommandIdSchema)(`cmd-${value}`))),
    connectionId: suffix().pipe(Effect.map((value) => Schema.decodeUnknownSync(ConnectionIdSchema)(`conn-${value}`))),
    apiTokenId: suffix().pipe(Effect.map((value) => Schema.decodeUnknownSync(ApiTokenIdSchema)(`tok-${value}`))),
    apiTokenSecret: Effect.sync(() => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const secret = Buffer.from(bytes).toString("base64url");
      return Schema.decodeUnknownSync(ApiTokenSecretSchema)(`${apiTokenPrefix}${secret}`);
    }),
    jobId: suffix().pipe(Effect.map((value) => `job-${value}`)),
    now: Effect.sync(() => decodeNow(Date.now())),
  };
});

/**
 * A deterministic identity for tests: identifiers count up, the clock advances by a fixed
 * step on every read.
 */
export function fixedIdentityLayer(options?: {
  readonly startAt?: string;
  readonly stepMillis?: number;
}): Layer.Layer<Identity> {
  return Layer.sync(Identity)(() => {
    let clock = new Date(options?.startAt ?? "2026-07-29T00:00:00.000Z").getTime();
    const step = options?.stepMillis ?? 1_000;
    const counters = new Map<string, number>();
    const next = (kind: string) => {
      const value = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, value);
      return String(value).padStart(6, "0");
    };
    return {
      bountyId: Effect.sync(() => Schema.decodeUnknownSync(BountyIdSchema)(`bty-${next("bounty")}`)),
      commandId: Effect.sync(() => Schema.decodeUnknownSync(CommandIdSchema)(`cmd-${next("command")}`)),
      connectionId: Effect.sync(() => Schema.decodeUnknownSync(ConnectionIdSchema)(`conn-${next("connection")}`)),
      apiTokenId: Effect.sync(() => Schema.decodeUnknownSync(ApiTokenIdSchema)(`tok-${next("token")}`)),
      apiTokenSecret: Effect.sync(() =>
        Schema.decodeUnknownSync(ApiTokenSecretSchema)(`${apiTokenPrefix}secret-${next("secret")}`),
      ),
      jobId: Effect.sync(() => `job-${next("job")}`),
      now: Effect.sync(() => {
        const at = clock;
        clock += step;
        return decodeNow(at);
      }),
    };
  });
}
