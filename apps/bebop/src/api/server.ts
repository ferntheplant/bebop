// Assembling the `bebop-api` process.
//
// The public API and the Swordfish gateway share one HTTP server, which is how SPEC
// section 24 deploys them: one container, one port behind Caddy.

import { BebopHttpApi } from "@bebop/contracts";
import type { PgClient } from "@effect/sql-pg";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { BearerAuthenticationLayer } from "#src/api/authentication.ts";
import { BountyHandlers, HealthHandlers, TokenHandlers } from "#src/api/handlers.ts";
import type { BebopConfiguration } from "#src/config.ts";
import { Identity } from "#src/domain/identity.ts";
import type { BountyRepository } from "#src/persistence/bounties.ts";
import type { CommandRepository } from "#src/persistence/commands.ts";
import type { BountyEventRepository } from "#src/persistence/events.ts";
import type { IdempotencyRepository } from "#src/persistence/idempotency.ts";
import type { LifecycleJobRepository } from "#src/persistence/jobs.ts";
import { SwordfishProjectionRepository } from "#src/persistence/swordfish.ts";
import type { ApiTokenRepository } from "#src/persistence/tokens.ts";
import { applyProjectionInput } from "#src/service/projection.ts";
import { SwordfishGatewayRoute } from "#src/swordfish-gateway/gateway.ts";

/** Everything the API's routes need, minus the HTTP server itself. */
export type ApiServices =
  | BebopConfiguration
  | Identity
  | PgClient.PgClient
  | ApiTokenRepository
  | BountyRepository
  | BountyEventRepository
  | CommandRepository
  | IdempotencyRepository
  | LifecycleJobRepository
  | SwordfishProjectionRepository;

export const BebopApiRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(BebopHttpApi).pipe(
    Layer.provide([HealthHandlers, BountyHandlers, TokenHandlers]),
    Layer.provide(BearerAuthenticationLayer),
  ),
  SwordfishGatewayRoute,
);

/**
 * Reconciles connection freshness for a process that has just started.
 *
 * Every WebSocket this Bebop had is gone: the sockets died with the previous process, but
 * the projections still record the connection they were bound to. Leaving them as
 * `connected` would break the one rule SPEC section 9.3 states outright — "a disconnected
 * Swordfish cannot be presented as currently working merely because its last event said
 * `implementing`".
 *
 * The workflow state itself is untouched; only the connection and its freshness are cleared,
 * and each bounty's event stream records the change so a client watching sees it.
 */
export const reconcileConnectionsOnStartup = Effect.gen(function* () {
  const identity = yield* Identity;
  const projections = yield* SwordfishProjectionRepository;
  const stale = yield* projections.connectedProjections(1_000);
  if (stale.length === 0) {
    return;
  }
  const detectedAt = yield* identity.now;
  for (const projection of stale) {
    if (projection.connectionId === null) {
      continue;
    }
    yield* applyProjectionInput({
      projection,
      input: { type: "connection_lost", connectionId: projection.connectionId, detectedAt },
      at: detectedAt,
    });
  }
  yield* Effect.logInfo("marked inherited swordfish connections disconnected").pipe(
    Effect.annotateLogs("connections", String(stale.length)),
  );
});
