// The `bebop-worker` container process (SPEC section 24).
//
// Same image, same repositories, different responsibilities: it works the durable job queue
// and sweeps connection freshness. It has no listener and serves no traffic, so an operator
// can scale or restart it without touching the API.

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Effect, Schedule } from "effect";

import { BebopConfiguration } from "#src/config.ts";
import { structuredLoggingLayer, withComponent } from "#src/observability/logging.ts";
import { migrateDatabase } from "#src/persistence/database.ts";
import { BebopRuntimeLayer, LocalLifecycleProviderLayer } from "#src/runtime/layers.ts";
import { runOneJob, sweepStaleConnections } from "#src/worker/jobs.ts";

export const bebopWorkerName = "bebop-worker";

/**
 * Drains the job queue, then sleeps.
 *
 * Draining in a loop rather than one job per tick matters when a backlog exists: a burst of
 * created bounties should provision at the speed of the provider, not at the speed of the
 * poll interval.
 */
const workJobs = Effect.fnUntraced(function* (workerId: string) {
  for (;;) {
    const worked = yield* runOneJob(workerId);
    if (!worked) {
      return;
    }
  }
});

export const runBebopWorker = Effect.gen(function* () {
  const config = yield* BebopConfiguration;
  yield* migrateDatabase;

  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  yield* Effect.logInfo("bebop worker started").pipe(Effect.annotateLogs("worker_id", workerId));

  // A failed tick must not end the loop: the next one may well succeed, and a worker that
  // dies on one bad job stops provisioning every other bounty too.
  const tick = Effect.gen(function* () {
    yield* workJobs(workerId);
    yield* sweepStaleConnections();
  }).pipe(Effect.catchCause((cause) => Effect.logError("worker tick failed", cause)));

  yield* Effect.repeat(tick, Schedule.spaced(config.workerPollInterval));
}).pipe(
  Effect.provide(LocalLifecycleProviderLayer),
  Effect.provide(BebopRuntimeLayer),
  Effect.provide(structuredLoggingLayer),
);

if (import.meta.main) {
  BunRuntime.runMain(withComponent("bebop-worker", runBebopWorker));
}
