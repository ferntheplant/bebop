import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Data, Effect, Layer } from "effect";
import type { SqlError } from "effect/unstable/sql";
import type { Migrator, SqlClient } from "effect/unstable/sql";
import { SqlClient as SqlClientTag } from "effect/unstable/sql";

import { SwordfishConfiguration } from "#src/config.ts";
import { swordfishMigrationLoader } from "#src/persistence/migrations.ts";

export class DatabaseDirectoryError extends Data.TaggedError("DatabaseDirectoryError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class DatabaseIntegrityError extends Data.TaggedError("DatabaseIntegrityError")<{
  readonly result: string;
}> {}

export const DatabaseLayer: Layer.Layer<
  SqliteClient.SqliteClient | SqlClient.SqlClient,
  DatabaseDirectoryError,
  SwordfishConfiguration
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* SwordfishConfiguration;
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(config.databasePath), { recursive: true }),
      catch: (cause) => new DatabaseDirectoryError({ path: dirname(config.databasePath), cause }),
    });
    return SqliteClient.layer({ filename: config.databasePath });
  }),
);

export const initializeDatabase: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError.SqlError | DatabaseIntegrityError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClientTag.SqlClient;
  yield* sql`PRAGMA busy_timeout = 5000`;
  yield* sql`PRAGMA foreign_keys = ON`;
  const applied = yield* SqliteMigrator.run({ loader: swordfishMigrationLoader });
  const rows = yield* sql`PRAGMA integrity_check`;
  const value = (rows[0] as { integrity_check?: unknown } | undefined)?.integrity_check;
  const result = typeof value === "string" ? value : "missing result";
  if (result !== "ok") {
    return yield* Effect.fail(new DatabaseIntegrityError({ result }));
  }
  const foreignKeyViolations = yield* sql`PRAGMA foreign_key_check`;
  if (foreignKeyViolations.length > 0) {
    return yield* Effect.fail(
      new DatabaseIntegrityError({ result: `${foreignKeyViolations.length} foreign-key violation(s)` }),
    );
  }
  yield* Effect.logInfo(applied.length === 0 ? "database schema is current" : "applied database migrations").pipe(
    Effect.annotateLogs("migrations_applied", String(applied.length)),
  );
  return applied;
});
