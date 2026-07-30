#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Effect, Fiber } from "effect";
import { SocketServer } from "effect/unstable/socket";

import { SwordfishConfiguration } from "#src/config.ts";
import { makeControlSocket, runControlServer } from "#src/control/server.ts";
import { ShutdownSignal } from "#src/daemon/shutdown.ts";
import { structuredLoggingLayer, withSwordfishComponent } from "#src/observability/logging.ts";
import { initializeDatabase } from "#src/persistence/database.ts";
import { runBebopClient } from "#src/protocol/client.ts";
import { SwordfishRuntimeLayer } from "#src/runtime/layers.ts";
import { WorkflowService } from "#src/workflow/service.ts";

export const swordfishDaemonName = "swordfish";

export const runSwordfishDaemon = Effect.gen(function* () {
  const config = yield* SwordfishConfiguration;
  const shutdown = yield* ShutdownSignal;
  const workflow = yield* WorkflowService;

  // The listener is the single-daemon lock. Acquire it before reconciliation can mutate
  // connection state, so a second process cannot touch the same SQLite authority.
  const controlServer = yield* makeControlSocket;
  yield* initializeDatabase;
  yield* workflow.bootstrap;
  const control = yield* Effect.forkScoped(
    runControlServer.pipe(Effect.provideService(SocketServer.SocketServer, controlServer)),
  );
  const protocol = yield* Effect.forkScoped(runBebopClient);
  yield* Effect.logInfo("Swordfish daemon started").pipe(
    Effect.annotateLogs("bounty_id", config.bountyId),
    Effect.annotateLogs("vm_id", config.vmId),
  );
  // A daemon without either transport is not healthy. Unexpected service completion wins
  // this race and fails the process instead of leaving a detached half-daemon alive.
  yield* Effect.raceFirst(shutdown.await, Effect.raceFirst(Fiber.join(control), Fiber.join(protocol)));
  yield* Effect.logInfo("Swordfish daemon stopping");
}).pipe(Effect.scoped, Effect.provide(SwordfishRuntimeLayer), Effect.provide(structuredLoggingLayer));

if (import.meta.main) {
  BunRuntime.runMain(withSwordfishComponent(runSwordfishDaemon));
}
