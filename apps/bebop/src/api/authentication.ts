// Bearer authentication for every route except `GET /api/health` (SPEC section 17.2, 17.4).
//
// The shape of this function matters more than its length. An Effect 4 security middleware
// **wraps the endpoint effect**: it receives the endpoint's own effect and must return it for
// the request to proceed. `spikes/effect-runtime` finding 1 records what goes wrong
// otherwise — a middleware that returns `Effect.void` on success silently skips the handler
// and answers with nothing, rather than failing in a way anyone would notice. Bebop declares
// this middleware on two whole groups, so every authenticated route depends on it.
//
// The corresponding test is therefore not only "an unauthorised request is refused" but
// "an authorised request reaches its handler".

import type { ApiTokenSecret } from "@bebop/contracts";
import { ApiTokenSecret as ApiTokenSecretSchema, BearerAuthentication } from "@bebop/contracts";
import { Effect, Layer, Redacted, Schema } from "effect";

import { newRequestId } from "#src/api/errors.ts";
import { Identity } from "#src/domain/identity.ts";
import { ApiTokenRepository } from "#src/persistence/tokens.ts";

const decodeSecret = Schema.decodeUnknownOption(ApiTokenSecretSchema);

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

      return BearerAuthentication.of({
        bearer: (httpEffect, { credential }) =>
          Effect.gen(function* () {
            const presented = decodeSecret(Redacted.value(credential));
            if (presented._tag === "None") {
              return yield* unauthorized("The bearer token is not a Bebop API token.");
            }
            const now = yield* identity.now;
            const authenticated = yield* tokens
              .authenticate({ secret: presented.value as ApiTokenSecret, usedAt: now })
              .pipe(
                // A database failure while checking a credential must refuse the request, not
                // crash the server and not admit it.
                Effect.catchCause((cause) =>
                  Effect.logError("could not verify bearer token", cause).pipe(Effect.as(null)),
                ),
              );
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
