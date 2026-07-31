// A disposable Postgres for component tests.
//
// Component tests run against a real disposable Postgres database — real, because the things being tested are the things a fake would
// paper over: transactional idempotency, `FOR UPDATE SKIP LOCKED`, advisory locks, `jsonb`
// round trips, and `bigint` coming back as a string.
//
// Each suite gets its own freshly created database, so suites cannot see each other's rows
// and a failed suite cannot poison the next run.

import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";

/**
 * Where to find a Postgres to borrow.
 *
 * CI sets this to its service container. Locally, `compose.yml` at the repository root
 * starts one:
 *
 * ```
 * docker compose up -d --wait postgres
 * export BEBOP_TEST_DATABASE_URL=postgres://bebop:bebop@127.0.0.1:5433/bebop
 * ```
 *
 * When it is unset, suites that need a database skip. That is a deliberate trade: a
 * contributor without Docker can still run `vp run ready`, and CI — which always sets it —
 * is where the criterion is actually enforced.
 */
export const testDatabaseUrlVariable = "BEBOP_TEST_DATABASE_URL";

export interface DisposableDatabase {
  readonly url: string;
  readonly drop: () => Promise<void>;
}

export function adminDatabaseUrl(): string | null {
  const url = process.env[testDatabaseUrlVariable];
  return url === undefined || url.length === 0 ? null : url;
}

/**
 * Creates a database and returns its URL plus the way to remove it.
 *
 * `CREATE DATABASE` cannot run inside a transaction and needs a connection to a *different*
 * database, which is why this opens a short-lived admin connection rather than reusing the
 * pooled client the code under test holds.
 */
export async function createDisposableDatabase(label: string): Promise<DisposableDatabase> {
  const admin = adminDatabaseUrl();
  if (admin === null) {
    throw new Error(`${testDatabaseUrlVariable} is not set.`);
  }

  const suffix = Math.random().toString(36).slice(2, 10);
  const name = `bebop_test_${sanitize(label)}_${suffix}`;

  // The identifier is built here from a sanitised label and random suffix, never from
  // caller-supplied text, which is why quoting it is sufficient.
  await statement(admin, `CREATE DATABASE "${name}"`);

  const url = new URL(admin);
  url.pathname = `/${name}`;

  return {
    url: url.href,
    drop: async () => {
      // `FORCE` because a connection left open by a leaked fiber would otherwise make the
      // drop fail and let the next run inherit the database.
      await statement(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}

function sanitize(label: string): string {
  return label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .slice(0, 24);
}

/** Runs one statement over a throwaway single connection. */
async function statement(url: string, sqlText: string): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.unsafe(sqlText);
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))),
  );
}
