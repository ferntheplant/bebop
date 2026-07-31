// Assembling the `bebop-api` process.
//
// The public API and the Swordfish gateway share one HTTP server, which is how `docs/design/SYSTEM.md`
// §24 deploys them: one container, one port behind Caddy.

import { ApiTokenName, BebopHttpApi } from "@bebop/contracts";
import type { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { BearerAuthenticationLayer } from "#src/api/authentication.ts";
import { BountyHandlers, HealthHandlers, TokenHandlers } from "#src/api/handlers.ts";
import { BebopConfiguration } from "#src/config.ts";
import { Identity } from "#src/domain/identity.ts";
import type { BountyRepository } from "#src/persistence/bounties.ts";
import type { CommandRepository } from "#src/persistence/commands.ts";
import type { BountyEventRepository } from "#src/persistence/events.ts";
import type { IdempotencyRepository } from "#src/persistence/idempotency.ts";
import type { LifecycleJobRepository } from "#src/persistence/jobs.ts";
import { SwordfishProjectionRepository } from "#src/persistence/swordfish.ts";
import { ApiTokenRepository } from "#src/persistence/tokens.ts";
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

const bootstrapTokenName = Schema.decodeUnknownSync(ApiTokenName)("bootstrap");

export class MissingBootstrapTokenError extends Error {
  readonly _tag = "MissingBootstrapTokenError";

  constructor() {
    super("BEBOP_BOOTSTRAP_API_TOKEN is required while the API token table is empty.");
    this.name = "MissingBootstrapTokenError";
  }
}

/** Makes a fresh database reachable without ever exposing an unauthenticated token route. */
export const ensureApiTokenBootstrap = Effect.gen(function* () {
  const config = yield* BebopConfiguration;
  const identity = yield* Identity;
  const tokens = yield* ApiTokenRepository;
  if (yield* tokens.hasAny) {
    return false;
  }
  if (config.bootstrapApiToken === undefined) {
    return yield* Effect.fail(new MissingBootstrapTokenError());
  }
  const tokenId = yield* identity.apiTokenId;
  const createdAt = yield* identity.now;
  return yield* tokens.bootstrap({
    tokenId,
    name: bootstrapTokenName,
    secret: Redacted.value(config.bootstrapApiToken),
    createdAt,
  });
});

/**
 * Reconciles connection freshness for a process that has just started.
 *
 * Every WebSocket this Bebop had is gone: the sockets died with the previous process, but
 * the projections still record the connection they were bound to. Leaving them as
 * `connected` would break the one rule `docs/design/SYSTEM.md` §9.3 states outright — "a disconnected
 * Swordfish cannot be presented as currently working merely because its last event said
 * `implementing`".
 *
 * The workflow state itself is untouched; only the connection and its freshness are cleared,
 * and each bounty's event stream records the change so a client watching sees it.
 */
export const reconcileConnectionsOnStartup = Effect.gen(function* () {
  const identity = yield* Identity;
  const projections = yield* SwordfishProjectionRepository;
  let reconciled = 0;
  for (;;) {
    const stale = yield* projections.connectedProjections(1_000);
    if (stale.length === 0) {
      break;
    }
    const detectedAt = yield* identity.now;
    for (const projection of stale) {
      if (projection.connectionId === null) {
        continue;
      }
      yield* applyProjectionInput({
        bountyId: projection.bountyId,
        vmId: projection.vmId,
        input: { type: "connection_lost", connectionId: projection.connectionId, detectedAt },
        at: detectedAt,
      });
      reconciled += 1;
    }
  }
  if (reconciled > 0) {
    yield* Effect.logInfo("marked inherited swordfish connections disconnected").pipe(
      Effect.annotateLogs("connections", String(reconciled)),
    );
  }
});
