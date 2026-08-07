// The layer stack both entrypoints share.
//
// `bebop-api` and `bebop-worker` run from the same image and the same repositories
// (`docs/capabilities/15-deployment-and-operation.md`). The only difference is which fibers
// they start, so
// they build from one definition of "connected to the database, with services" rather than
// two that can drift.

import type { PgClient } from "@effect/sql-pg";
import type { Config } from "effect";
import { Duration, Effect, Layer } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";

import type { BebopConfiguration } from "#src/config.ts";
import { BebopConfiguration as BebopConfigurationTag, BebopConfigurationLayer } from "#src/config.ts";
import type { Identity } from "#src/domain/identity.ts";
import { IdentityLayer } from "#src/domain/identity.ts";
import { defaultStopGracePeriodMillis, makeLocalSwordfishSupervisor } from "#src/lifecycle/local-daemon.ts";
import { LocalProcessRunnerLayer } from "#src/lifecycle/local-process.ts";
import type { LifecycleProvider } from "#src/lifecycle/provider.ts";
import { fakeLifecycleProviderLayer } from "#src/lifecycle/provider.ts";
import type { BountyRepository } from "#src/persistence/bounties.ts";
import { BountyRepositoryLayer } from "#src/persistence/bounties.ts";
import type { CommandRepository } from "#src/persistence/commands.ts";
import { CommandRepositoryLayer } from "#src/persistence/commands.ts";
import { DatabaseLayer } from "#src/persistence/database.ts";
import type { BountyEventRepository } from "#src/persistence/events.ts";
import { BountyEventRepositoryLayer } from "#src/persistence/events.ts";
import type { IdempotencyRepository } from "#src/persistence/idempotency.ts";
import { IdempotencyRepositoryLayer } from "#src/persistence/idempotency.ts";
import type { LifecycleJobRepository } from "#src/persistence/jobs.ts";
import { LifecycleJobRepositoryLayer } from "#src/persistence/jobs.ts";
import type { SwordfishProjectionRepository } from "#src/persistence/swordfish.ts";
import { SwordfishProjectionRepositoryLayer } from "#src/persistence/swordfish.ts";
import type { ApiTokenRepository } from "#src/persistence/tokens.ts";
import { ApiTokenRepositoryLayer } from "#src/persistence/tokens.ts";

export type BebopRepositories =
  | ApiTokenRepository
  | BountyRepository
  | BountyEventRepository
  | CommandRepository
  | IdempotencyRepository
  | LifecycleJobRepository
  | SwordfishProjectionRepository;

/** Every repository, over an already-provided `PgClient`. */
export const RepositoriesLayer: Layer.Layer<BebopRepositories, never, PgClient.PgClient | SqlClient.SqlClient> =
  Layer.mergeAll(
    ApiTokenRepositoryLayer,
    BountyRepositoryLayer,
    BountyEventRepositoryLayer,
    CommandRepositoryLayer,
    IdempotencyRepositoryLayer,
    LifecycleJobRepositoryLayer,
    SwordfishProjectionRepositoryLayer,
  );

/**
 * Configuration, identity, the database, and every repository.
 *
 * The lifecycle provider is deliberately not here: the fake one runs today and exe.dev runs
 * later (`docs/capabilities/02-provisioning-and-attachment.md`), and each entrypoint chooses. Burying that choice in the shared stack would
 * make it the sort of thing that gets swapped by accident.
 */
export const BebopRuntimeLayer: Layer.Layer<
  BebopConfiguration | Identity | PgClient.PgClient | SqlClient.SqlClient | BebopRepositories,
  Config.ConfigError | SqlError.SqlError,
  never
> = RepositoriesLayer.pipe(
  Layer.provideMerge(DatabaseLayer),
  Layer.provideMerge(Layer.mergeAll(BebopConfigurationLayer, IdentityLayer)),
);

/**
 * The lifecycle provider that runs today: the fake one, which locally also runs the machine.
 *
 * With `BEBOP_LOCAL_HARNESS_ROOT` set, a provisioned bounty is a real detached Swordfish daemon
 * on this host rather than only a record ("A local Swordfish outlives the worker that started
 * it" (ADR 0048)). Without it the provider fabricates records and starts nothing, which is what
 * every component suite and any non-local deployment gets.
 */
/** A duration in the one syntax Swordfish's own configuration schema parses back. */
function millisSetting(duration: Duration.Duration): string {
  return `${Duration.toMillis(duration)} millis`;
}

export const LocalLifecycleProviderLayer: Layer.Layer<LifecycleProvider, never, BebopConfiguration> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* BebopConfigurationTag;
    const root = config.localHarnessRoot;
    const entrypoint = config.localSwordfishEntrypoint;
    if (root === undefined || entrypoint === undefined) return fakeLifecycleProviderLayer({});
    // `BEBOP_LOCAL_HARNESS_ROOT` turns this process into something that spawns daemons and
    // clones repositories on its own host. That is the whole point of it locally, and a
    // deployment accident anywhere else, so it never starts quietly.
    //
    // A warning is a recorded compromise, not a guard: whether this should be impossible in
    // production rather than merely loud is still open (`docs/gotchas.md`).
    yield* Effect.logWarning(
      "local machine mode is enabled; every provision starts a Swordfish daemon on this host",
    ).pipe(Effect.annotateLogs("local_harness_root", root));
    const supervisor = yield* makeLocalSwordfishSupervisor({
      root,
      swordfishEntrypoint: entrypoint,
      // The daemon dials back to this same process over loopback, so the address is derived
      // rather than configured: a second key here could only ever disagree with the port the
      // gateway is actually listening on.
      bebopWebSocketUrl: `ws://127.0.0.1:${config.port}/swordfish`,
      openCodeBaseUrl: (config.localOpenCodeBaseUrl ?? new URL("http://127.0.0.1:4096/")).href,
      gitRemoteBase: (config.localGitRemoteBase ?? new URL("https://github.com/")).href,
      // The machine's cadences track bebop's own, so a local loop does not have one side
      // heartbeating on a schedule the other calls stale. Millis rather than `Duration.format`:
      // that prints `5s`, which the daemon's own `DurationFromString` refuses — a mismatch that
      // surfaces only as a daemon exiting at startup in a log nobody is tailing.
      heartbeatInterval: millisSetting(config.heartbeatInterval),
      reconnectMinimumDelay: "1000 millis",
      reconnectMaximumDelay: "30000 millis",
      shutdownTimeout: millisSetting(config.shutdownTimeout),
      stopGracePeriodMillis: defaultStopGracePeriodMillis,
    }).pipe(Effect.provide(LocalProcessRunnerLayer));
    return fakeLifecycleProviderLayer({ supervisor });
  }),
);
