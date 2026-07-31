// The layer stack both entrypoints share.
//
// `bebop-api` and `bebop-worker` run from the same image and the same repositories
// (`docs/design/SYSTEM.md` §24, Milestone 3). The only difference is which fibers they start, so
// they build from one definition of "connected to the database, with services" rather than
// two that can drift.

import type { PgClient } from "@effect/sql-pg";
import type { Config } from "effect";
import { Layer } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";

import type { BebopConfiguration } from "#src/config.ts";
import { BebopConfigurationLayer } from "#src/config.ts";
import type { Identity } from "#src/domain/identity.ts";
import { IdentityLayer } from "#src/domain/identity.ts";
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
 * The lifecycle provider is deliberately not here: Milestone 3 runs the fake one, Milestone 9
 * runs exe.dev, and each entrypoint chooses. Burying that choice in the shared stack would
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

/** The lifecycle provider this milestone runs (Milestone 3). */
export const LocalLifecycleProviderLayer: Layer.Layer<LifecycleProvider> = fakeLifecycleProviderLayer();
