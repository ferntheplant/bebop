import { adminDatabaseUrl, createDisposableDatabase } from "@bebop/testkit";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { migrateDatabase } from "#src/persistence/database.ts";

const suite = adminDatabaseUrl() === null ? describe.skip : describe;

suite("database migrations", () => {
  test("serialize concurrent migration attempts on a fresh database", async () => {
    const database = await createDisposableDatabase("concurrent-migrations");
    try {
      const migrate = () =>
        Effect.runPromise(
          migrateDatabase.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 1 }))),
        );

      const results = await Promise.all([migrate(), migrate()]);
      expect(results.filter((applied) => applied.length > 0)).toHaveLength(1);
      expect(results.filter((applied) => applied.length === 0)).toHaveLength(1);
    } finally {
      await database.drop();
    }
  });
});
