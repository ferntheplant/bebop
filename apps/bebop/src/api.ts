// The `bebop-api` container process (SPEC section 24).
//
// It serves the public API and accepts Swordfish connections on one port, runs migrations
// before listening, reconciles inherited connection freshness, and shuts down on a signal
// without dropping work in flight.

// Deep imports rather than the package barrel: the barrel re-exports `BunRedis`, which
// imports the `bun` module at load time and therefore cannot be loaded by a Node-hosted test
// runner even when nothing in this file touches Redis.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Duration, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { BebopApiRoutes, reconcileConnectionsOnStartup } from "#src/api/server.ts";
import { BebopConfiguration } from "#src/config.ts";
import { structuredLoggingLayer, withComponent } from "#src/observability/logging.ts";
import { migrateDatabase } from "#src/persistence/database.ts";
import { BebopRuntimeLayer, LocalLifecycleProviderLayer } from "#src/runtime/layers.ts";
import { withBoundedShutdown } from "#src/runtime/shutdown.ts";

export { BebopHttpApi } from "@bebop/contracts";

export const bebopApiName = "bebop-api";

/** The HTTP server, sized and bound from configuration. */
const ServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* BebopConfiguration;
    // The server layer's finalizer is a graceful `server.stop()`, which is bounded here so a
    // connection that never finishes closing cannot hold the process open forever.
    return withBoundedShutdown(HttpRouter.serve(BebopApiRoutes), config.shutdownTimeout).pipe(
      Layer.provideMerge(
        BunHttpServer.layer({
          port: config.port,
          hostname: config.host,
          // See `httpIdleTimeout` in the configuration: Bun's ten-second default would drop
          // every idle event-stream subscriber.
          idleTimeout: Math.round(Duration.toSeconds(config.httpIdleTimeout)),
        }),
      ),
    );
  }),
);

/**
 * Starts the server and stays up until interrupted.
 *
 * Migrations and reconciliation run before the listener exists, so the process is never
 * reachable in a state where it would answer using a schema it has not applied.
 */
export const runBebopApi = Effect.gen(function* () {
  const config = yield* BebopConfiguration;
  yield* migrateDatabase;
  yield* reconcileConnectionsOnStartup;

  yield* Effect.logInfo("bebop api listening").pipe(
    Effect.annotateLogs("host", config.host),
    Effect.annotateLogs("port", String(config.port)),
  );

  // The server runs for the life of this scope; `never` holds the scope open until the
  // runtime interrupts it on SIGINT or SIGTERM, at which point the listener closes through
  // its own finalizer. A clean shutdown surfaces as an interrupt rather than a failure
  // (`spikes/effect-runtime`, finding 5), which is why nothing here treats it as an error.
  yield* Effect.never;
}).pipe(
  Effect.provide(ServerLayer),
  Effect.provide(LocalLifecycleProviderLayer),
  Effect.provide(BebopRuntimeLayer),
  // Replaces the pretty logger `runMain` installs, which is the wrong shape for a container
  // whose logs are collected by line.
  Effect.provide(structuredLoggingLayer),
);

if (import.meta.main) {
  BunRuntime.runMain(withComponent("bebop-api", runBebopApi));
}
