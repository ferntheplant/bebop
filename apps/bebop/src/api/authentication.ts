// Bearer authentication for every route except `GET /api/health` (`docs/design/SYSTEM.md` §17.2, 17.4).
//
// The shape of this function matters more than its length. An Effect 4 security middleware
// **wraps the endpoint effect**: it receives the endpoint's own effect and must return it for
// the request to proceed. `prototypes/effect-runtime` finding 1 records what goes wrong
// otherwise — a middleware that returns `Effect.void` on success silently skips the handler
// and answers with nothing, rather than failing in a way anyone would notice. Bebop declares
// this middleware on two whole groups, so every authenticated route depends on it.
//
// The corresponding test is therefore not only "an unauthorised request is refused" but
// "an authorised request reaches its handler".

import type { ApiTokenSecret } from "@bebop/contracts";
import { ApiTokenSecret as ApiTokenSecretSchema, BearerAuthentication } from "@bebop/contracts";
import { Duration, Effect, Layer, Redacted, Result, Schedule, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";

import { internalError, newRequestId } from "#src/api/errors.ts";
import { Identity } from "#src/domain/identity.ts";
import { ApiTokenRepository } from "#src/persistence/tokens.ts";

const decodeSecret = Schema.decodeUnknownOption(ApiTokenSecretSchema);

/**
 * How hard credential lookup tries before a transient database failure becomes a 5xx.
 *
 * The lookup is a single indexed equality, so the only failures it sees are transient: a
 * pooled connection that timed out or was dropped mid-request. Retrying a few times with a
 * short backoff lets a contended pool recover without ever telling a valid client its token
 * is dead. The schedule is bounded so a genuinely broken database surfaces rather than
 * hanging the request forever.
 */
const verifyCredentialSchedule = Schedule.exponential(Duration.millis(5), 2).pipe(
  Schedule.upTo({ duration: Duration.millis(60) }),
);

export const BearerAuthenticationLayer: Layer.Layer<BearerAuthentication, never, ApiTokenRepository | Identity> =
  Layer.effect(BearerAuthentication)(
    Effect.gen(function* () {
      const tokens = yield* ApiTokenRepository;
      const identity = yield* Identity;

      const unauthorized = (message: string) =>
        Effect.gen(function* () {
          const requestId = yield* newRequestId;
          return yield* Effect.fail({ code: "unauthorized" as const, message, requestId });
        });

      // Refuses the request without admitting it and without misreporting a backend failure
      // as an auth failure. A 401 would make a valid client discard a working token; a 500 is
      // the honest signal that the credential was never checked.
      const unavailable = (cause: SqlError.SqlError) =>
        Effect.gen(function* () {
          yield* Effect.logError("could not verify bearer token", cause);
          const body = yield* internalError("The request could not be authenticated.");
          return yield* Effect.fail(body);
        });

      return BearerAuthentication.of({
        bearer: (httpEffect, { credential }) =>
          Effect.gen(function* () {
            const presented = decodeSecret(Redacted.value(credential));
            if (presented._tag === "None") {
              return yield* unauthorized("The bearer token is not a Bebop API token.");
            }
            const now = yield* identity.now;
            // Retry transient SQL failures before deciding. Only a definitive "no matching
            // row" is an auth failure; a database error that survived its retries is an
            // internal failure, not a credential problem.
            const verified = yield* Effect.result(
              tokens
                .authenticate({ secret: presented.value as ApiTokenSecret, usedAt: now })
                .pipe(Effect.retry(verifyCredentialSchedule)),
            );
            if (Result.isFailure(verified)) {
              return yield* unavailable(verified.failure);
            }
            const authenticated = verified.success;
            if (authenticated === null) {
              return yield* unauthorized("The bearer token is unknown or revoked.");
            }
            // Returning the endpoint's own effect is what lets the request through.
            return yield* httpEffect.pipe(
              Effect.annotateLogs("api_token", authenticated.name),
              Effect.annotateLogs("api_token_id", authenticated.tokenId),
            );
          }),
      });
    }),
  );
