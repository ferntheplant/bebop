// The Postgres connection and its migration step.
//
// Both entrypoints provide this layer. Migrations run at startup from the packed schema
// record (`docs/design/SYSTEM.md` §24: "backward-compatible database migrations"), and both processes
// may attempt them concurrently — the migrator takes an ACCESS EXCLUSIVE lock and treats a
// losing racer as already-running rather than as an error.

import * as BunServices from "@effect/platform-bun/BunServices";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import type { SqlError } from "effect/unstable/sql";
import type { Migrator } from "effect/unstable/sql";
import type { SqlClient } from "effect/unstable/sql";

import { BebopConfiguration } from "#src/config.ts";
import { bebopMigrationLoader } from "#src/persistence/migrations.ts";

export const DatabaseLayer: Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  SqlError.SqlError,
  BebopConfiguration
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* BebopConfiguration;
    return PgClient.layer({
      url: Redacted.make(Redacted.value(config.databaseUrl).href),
      maxConnections: config.databasePoolSize,
      applicationName: "bebop",
    });
  }),
);

/**
 * Applies pending migrations and says which ran, so startup logs record the schema move.
 *
 * `PgMigrator.run` reaches for `FileSystem`, `Path`, and a process spawner in order to dump
 * a schema file after a successful run. No `schemaDirectory` is configured here, so nothing
 * is dumped — but the services are still required, and `BunServices` supplies them.
 */
export const migrateDatabase: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError.SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const applied = yield* PgMigrator.run({ loader: bebopMigrationLoader });
  yield* Effect.logInfo(applied.length === 0 ? "database schema is current" : "applied database migrations").pipe(
    Effect.annotateLogs("migrations_applied", String(applied.length)),
  );
  return applied;
}).pipe(Effect.provide(BunServices.layer));
