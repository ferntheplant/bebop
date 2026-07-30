#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Duration, Effect, Fiber, Scope } from "effect";
import { SocketServer } from "effect/unstable/socket";

import { SwordfishConfiguration } from "#src/config.ts";
import { makeAuthorityLock, makeControlSocket, runControlServer } from "#src/control/server.ts";
import { ShutdownSignal } from "#src/daemon/shutdown.ts";
import { structuredLoggingLayer, withSwordfishComponent } from "#src/observability/logging.ts";
import { initializeDatabase } from "#src/persistence/database.ts";
import { runBebopClient } from "#src/protocol/client.ts";
import { SwordfishRuntimeLayer } from "#src/runtime/layers.ts";
import { WorkflowService } from "#src/workflow/service.ts";

export const swordfishDaemonName = "swordfish";

export const runSwordfishDaemon = Effect.gen(function* () {
  const config = yield* SwordfishConfiguration;
  const scope = yield* Scope.make();

  // The durable identity annotates every log in the daemon, including the forked
  // transport fibers, which inherit this fiber's context at fork time.
  const daemon = Effect.gen(function* () {
    const shutdown = yield* ShutdownSignal;
    const workflow = yield* WorkflowService;

    // The database-derived listener owns the SQLite authority even when operators configure
    // different control sockets. Acquire both listeners before reconciliation mutates state.
    yield* makeAuthorityLock;
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
  }).pipe(Scope.provide(scope), Effect.annotateLogs({ bounty_id: config.bountyId, vm_id: config.vmId }));

  const exit = yield* Effect.exit(daemon);
  // Scope finalizers are unbounded by default, so a stuck socket or server finalizer could
  // outlive the supervisor's grace period. Close in a detached daemon fiber and give up on
  // it after the configured shutdown timeout; `runMain` exits once this fiber completes.
  // Interrupting `Fiber.join` detaches from the close instead of interrupting it, while a
  // plain race would wait for the close to acknowledge interruption and hang with it.
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const closing = yield* Effect.forkDetach(Scope.close(scope, exit));
      yield* Effect.raceFirst(
        Fiber.join(closing),
        Effect.sleep(config.shutdownTimeout).pipe(
          Effect.andThen(
            Effect.logWarning("Swordfish shutdown timed out; abandoning remaining finalizers").pipe(
              Effect.annotateLogs("shutdown_timeout_ms", String(Duration.toMillis(config.shutdownTimeout))),
            ),
          ),
        ),
      );
    }),
  );
  if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause);
}).pipe(Effect.provide(SwordfishRuntimeLayer), Effect.provide(structuredLoggingLayer));

if (import.meta.main) {
  BunRuntime.runMain(withSwordfishComponent(runSwordfishDaemon));
}
