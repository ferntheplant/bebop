#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import type { Exit } from "effect";
import { Data, Duration, Effect, Fiber, Layer, Scope } from "effect";
import { SocketServer } from "effect/unstable/socket";

import { loadSwordfishConfig, SwordfishConfiguration, swordfishConfigurationLayerFrom } from "#src/config.ts";
import { makeAuthorityLock, makeControlSocket, runControlServer } from "#src/control/server.ts";
import { ShutdownSignal } from "#src/daemon/shutdown.ts";
import { structuredLoggingLayer, withSwordfishComponent } from "#src/observability/logging.ts";
import { initializeDatabase } from "#src/persistence/database.ts";
import { runBebopClient } from "#src/protocol/client.ts";
import { swordfishRuntimeLayer } from "#src/runtime/layers.ts";
import { WorkflowService } from "#src/workflow/service.ts";

export const swordfishDaemonName = "swordfish";

export class ShutdownTimeoutError extends Data.TaggedError("ShutdownTimeoutError")<{
  readonly timeoutMillis: number;
}> {}

export const closeScopeWithin = Effect.fnUntraced(function* (
  scope: Scope.Scope,
  exit: Exit.Exit<unknown, unknown>,
  timeout: Duration.Duration,
) {
  const closing = yield* Effect.forkDetach(Scope.close(scope, exit));
  const timedOut = yield* Effect.raceFirst(
    Fiber.join(closing).pipe(Effect.as(false)),
    Effect.sleep(timeout).pipe(
      Effect.andThen(
        Effect.logWarning("Swordfish shutdown timed out; abandoning remaining finalizers").pipe(
          Effect.annotateLogs("shutdown_timeout_ms", String(Duration.toMillis(timeout))),
        ),
      ),
      Effect.as(true),
    ),
  );
  if (timedOut) {
    return yield* Effect.fail(new ShutdownTimeoutError({ timeoutMillis: Duration.toMillis(timeout) }));
  }
});

export const runSwordfishDaemon = Effect.gen(function* () {
  const config = yield* loadSwordfishConfig();
  const scope = yield* Scope.make();
  const authority = yield* Effect.exit(
    makeAuthorityLock.pipe(Scope.provide(scope), Effect.provideService(SwordfishConfiguration, config), Effect.asVoid),
  );
  if (authority._tag === "Failure") {
    yield* Effect.uninterruptible(closeScopeWithin(scope, authority, config.shutdownTimeout));
    return yield* Effect.failCause(authority.cause);
  }
  const runtime = yield* Effect.exit(
    Layer.buildWithScope(swordfishRuntimeLayer({ configuration: swordfishConfigurationLayerFrom(config) }), scope),
  );
  if (runtime._tag === "Failure") {
    yield* Effect.uninterruptible(closeScopeWithin(scope, runtime, config.shutdownTimeout));
    return yield* Effect.failCause(runtime.cause);
  }

  // The durable identity annotates every log in the daemon, including the forked
  // transport fibers, which inherit this fiber's context at fork time.
  const daemon = Effect.gen(function* () {
    const shutdown = yield* ShutdownSignal;
    const workflow = yield* WorkflowService;

    // The database-derived listener owns the SQLite authority even when operators configure
    // different control sockets. Acquire both listeners before reconciliation mutates state.
    const controlServer = yield* makeControlSocket;
    yield* initializeDatabase;
    yield* workflow.bootstrap;
    const control = yield* Effect.forkScoped(
      runControlServer.pipe(Effect.provideService(SocketServer.SocketServer, controlServer)),
    );
    const protocol = yield* Effect.forkScoped(runBebopClient);
    yield* Effect.logInfo("Swordfish daemon started");
    // A daemon without either transport is not healthy. Unexpected service completion wins
    // this race and fails the process instead of leaving a detached half-daemon alive.
    yield* Effect.raceFirst(shutdown.await, Effect.raceFirst(Fiber.join(control), Fiber.join(protocol)));
    yield* Effect.logInfo("Swordfish daemon stopping");
  }).pipe(
    Scope.provide(scope),
    Effect.provide(runtime.value),
    Effect.annotateLogs({ bounty_id: config.bountyId, vm_id: config.vmId }),
  );

  const exit = yield* Effect.exit(daemon);
  // The runtime layer and transport fibers share this scope. If finalization misses the
  // deadline, fail the main effect so BunRuntime forces process exit despite retained handles.
  yield* Effect.uninterruptible(closeScopeWithin(scope, exit, config.shutdownTimeout));
  if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause);
}).pipe(Effect.provide(structuredLoggingLayer));

if (import.meta.main) {
  BunRuntime.runMain(withSwordfishComponent(runSwordfishDaemon));
}
