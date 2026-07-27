// Spike driver: proves one Effect process on the pinned Bun round-trips durable state
// through both authoritative stores -- Postgres for bebop (SPEC section 22.1) and SQLite
// for Swordfish (SPEC section 22.2).
//
// PLAN Milestone 0 asks only for "a small Effect process round-trips one row through
// Postgres and SQLite". A bare insert-then-select would pass that sentence while leaving
// every property Milestones 3 and 4 actually depend on unproven, so the probes below also
// pin down the things that would be expensive to discover later: migration idempotency,
// transaction rollback, whether a constraint violation is a typed failure or a defect,
// integer fidelity for protocol sequence numbers, WAL reader/writer concurrency, and
// whether a committed SQLite transaction survives SIGKILL.
//
// Every probe records what it observed, not just whether it liked it. The process exits
// nonzero if any probe fails.

import { rm } from "node:fs/promises";

import { BunServices } from "@effect/platform-bun";
import { PgClient, PgMigrator } from "@effect/sql-pg";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { spawn } from "bun";
import { Effect, Exit, Layer, Redacted, Result, Schema } from "effect";
import { Migrator, SqlClient, SqlError } from "effect/unstable/sql";

const here = import.meta.dir;
const scratch = `${here}/.spike`;
const sqlitePath = `${scratch}/swordfish.sqlite`;
const composeFile = `${here}/compose.yml`;

// --- probe harness -----------------------------------------------------------------

interface ProbeResult {
  readonly store: "postgres" | "sqlite";
  readonly id: string;
  readonly question: string;
  readonly pass: boolean;
  readonly observed: unknown;
}

const results: Array<ProbeResult> = [];

/**
 * Runs one probe. `body` returns the observation plus its own verdict, so a probe that
 * discovers something surprising reports the surprise rather than throwing it away.
 */
const probe = <E, R>(
  store: ProbeResult["store"],
  id: string,
  question: string,
  body: Effect.Effect<{ readonly pass: boolean; readonly observed: unknown }, E, R>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(body);
    const outcome = Exit.isSuccess(exit)
      ? exit.value
      : { pass: false, observed: { unexpectedFailure: String(exit.cause) } };
    results.push({ store, id, question, pass: outcome.pass, observed: outcome.observed });
    process.stdout.write(
      `  ${outcome.pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${question}\n` +
        `              ${JSON.stringify(outcome.observed)}\n`,
    );
  });

// --- shared shapes -----------------------------------------------------------------

// The decode step is the point of the round trip: a row that comes back but cannot be
// decoded into a domain value has not survived, it has merely been stored.
const BountyRow = Schema.Struct({
  bounty_id: Schema.String,
  state: Schema.Literals(["provisioning", "interactive", "autonomous"]),
});

const WorkflowEventRow = Schema.Struct({
  sequence: Schema.Number,
  stage: Schema.String,
  payload: Schema.String,
});

const eventPayload = {
  candidateSha: "9f2c1de6a4b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1",
  specRevision: 3,
  findings: ["validator: ok", "review: ok"],
};

// Postgres bigint is the widest column a protocol sequence number can land in. Anything
// above 2^53 - 1 is where a driver that hands back a JavaScript double loses digits.
const beyondSafeInteger = "9007199254740993"; // 2^53 + 1

// --- Postgres --------------------------------------------------------------------

const postgresProbes = Effect.gen(function* () {
  // `PgClient` rather than `SqlClient`: the `json` fragment helper is Postgres-specific and
  // is only reachable through the driver's own service.
  const sql = yield* PgClient.PgClient;

  yield* probe(
    "postgres",
    "PG1",
    "Migrator applies migrations from the filesystem",
    Effect.gen(function* () {
      const applied = yield* PgMigrator.run({ loader: Migrator.fromFileSystem(`${here}/migrations/pg`) });
      return { pass: applied.length === 2, observed: { applied } };
    }),
  );

  yield* probe(
    "postgres",
    "PG2",
    "re-running the migrator is a no-op",
    Effect.gen(function* () {
      const applied = yield* PgMigrator.run({ loader: Migrator.fromFileSystem(`${here}/migrations/pg`) });
      return { pass: applied.length === 0, observed: { appliedOnSecondRun: applied } };
    }),
  );

  yield* probe(
    "postgres",
    "PG3",
    "one row round-trips and decodes into a domain value",
    Effect.gen(function* () {
      yield* sql`INSERT INTO bounties ${sql.insert({ bounty_id: "bnt_spike", state: "interactive" })}`;
      const rows = yield* sql`SELECT bounty_id, state FROM bounties WHERE bounty_id = ${"bnt_spike"}`;
      const decoded = yield* Schema.decodeUnknownEffect(BountyRow)(rows[0]);
      return { pass: decoded.bounty_id === "bnt_spike" && decoded.state === "interactive", observed: decoded };
    }),
  );

  yield* probe(
    "postgres",
    "PG4",
    "jsonb round-trips a structured event payload with its values intact",
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO swordfish_events ${sql.insert({
          bounty_id: "bnt_spike",
          sequence: 1,
          payload: sql.json(eventPayload),
        })}
      `;
      const rows = yield* sql`SELECT payload FROM swordfish_events WHERE sequence = 1`;
      const stored = (rows[0] as { payload: unknown }).payload;
      return {
        pass: Bun.deepEquals(stored, eventPayload),
        observed: { stored, type: typeof stored, deepEqual: Bun.deepEquals(stored, eventPayload) },
      };
    }),
  );

  // Values survive; byte-for-byte layout does not. jsonb normalises the document, so a
  // fingerprint recomputed from a jsonb read will not match one taken over the wire.
  // Milestone 2 decided reducers "retain fingerprints for every applied sequence so
  // conflicting replay fails closed" -- this probe pins down where those fingerprints
  // may be computed.
  yield* probe(
    "postgres",
    "PG4b",
    "jsonb does NOT preserve key order, so fingerprints cannot be recomputed from it",
    Effect.gen(function* () {
      const rows = yield* sql`SELECT payload FROM swordfish_events WHERE sequence = 1`;
      const stored = (rows[0] as { payload: unknown }).payload;
      const storedKeys = Object.keys(stored as Record<string, unknown>);
      const originalKeys = Object.keys(eventPayload);
      const reordered = JSON.stringify(storedKeys) !== JSON.stringify(originalKeys);
      return {
        // Passing means the spike confirmed the documented behaviour it is warning about.
        pass: reordered,
        observed: {
          originalKeyOrder: originalKeys,
          storedKeyOrder: storedKeys,
          reserialisedMatchesOriginalBytes: JSON.stringify(stored) === JSON.stringify(eventPayload),
        },
      };
    }),
  );

  yield* probe(
    "postgres",
    "PG5",
    "a bigint sequence above 2^53 survives without losing digits",
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO swordfish_events (bounty_id, sequence, payload)
        VALUES (${"bnt_spike"}, ${beyondSafeInteger}, ${sql.json({ probe: "PG5" })})
      `;
      const rows = yield* sql`
        SELECT sequence FROM swordfish_events WHERE sequence = ${beyondSafeInteger}
      `;
      const sequence = (rows[0] as { sequence: unknown }).sequence;
      return {
        pass: String(sequence) === beyondSafeInteger,
        observed: { returned: String(sequence), javascriptType: typeof sequence, expected: beyondSafeInteger },
      };
    }),
  );

  yield* probe(
    "postgres",
    "PG6",
    "a failed transaction rolls back its durable intent",
    Effect.gen(function* () {
      const attempt = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO bounties ${sql.insert({ bounty_id: "bnt_rollback", state: "provisioning" })}`;
            return yield* Effect.fail(new Error("side effect refused after durable intent"));
          }),
        ),
      );
      const rows = yield* sql`SELECT bounty_id FROM bounties WHERE bounty_id = ${"bnt_rollback"}`;
      return {
        pass: Exit.isFailure(attempt) && rows.length === 0,
        observed: { transactionFailed: Exit.isFailure(attempt), rowsRemaining: rows.length },
      };
    }),
  );

  yield* probe(
    "postgres",
    "PG7",
    "a unique violation is a typed SqlError, not a defect",
    Effect.gen(function* () {
      yield* sql`INSERT INTO idempotency_keys ${sql.insert({ key: "idem_1", bounty_id: "bnt_spike" })}`;
      // `Effect.result` narrows to the typed failure channel. A violation that arrived as a
      // defect instead would not appear here at all -- it would abort the probe and be
      // reported as an unexpected failure, which is the distinction being tested.
      const outcome = yield* Effect.result(
        sql`INSERT INTO idempotency_keys ${sql.insert({ key: "idem_1", bounty_id: "bnt_spike" })}`,
      );
      if (Result.isSuccess(outcome)) {
        return { pass: false, observed: { outcome: "duplicate insert unexpectedly succeeded" } };
      }
      const error = outcome.failure;
      return {
        pass: SqlError.isSqlError(error),
        observed: {
          channel: "typed failure",
          tag: error._tag,
          reason: (error as { reason?: { _tag?: string } }).reason?._tag,
          isSqlError: SqlError.isSqlError(error),
        },
      };
    }),
  );
});

// --- SQLite ------------------------------------------------------------------------

const sqliteProbes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* probe(
    "sqlite",
    "SQ1",
    "the database opens in WAL mode with a busy timeout",
    Effect.gen(function* () {
      const journal = yield* sql`PRAGMA journal_mode`;
      yield* sql`PRAGMA busy_timeout = 5000`;
      const busy = yield* sql`PRAGMA busy_timeout`;
      const mode = String((journal[0] as { journal_mode: unknown }).journal_mode).toLowerCase();
      return {
        pass: mode === "wal" && Number((busy[0] as { timeout: unknown }).timeout) === 5000,
        observed: { journalMode: mode, busyTimeout: busy[0] },
      };
    }),
  );

  yield* probe(
    "sqlite",
    "SQ2",
    "Migrator applies migrations from the filesystem",
    Effect.gen(function* () {
      const applied = yield* SqliteMigrator.run({ loader: Migrator.fromFileSystem(`${here}/migrations/sqlite`) });
      return { pass: applied.length === 2, observed: { applied } };
    }),
  );

  yield* probe(
    "sqlite",
    "SQ3",
    "re-running the migrator is a no-op",
    Effect.gen(function* () {
      const applied = yield* SqliteMigrator.run({ loader: Migrator.fromFileSystem(`${here}/migrations/sqlite`) });
      return { pass: applied.length === 0, observed: { appliedOnSecondRun: applied } };
    }),
  );

  yield* probe(
    "sqlite",
    "SQ4",
    "one workflow event round-trips and decodes into a domain value",
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO workflow_events ${sql.insert({
          sequence: 1,
          stage: "implementing",
          payload: JSON.stringify(eventPayload),
        })}
      `;
      const rows = yield* sql`SELECT sequence, stage, payload FROM workflow_events WHERE sequence = 1`;
      const decoded = yield* Schema.decodeUnknownEffect(WorkflowEventRow)(rows[0]);
      return {
        pass: decoded.stage === "implementing" && JSON.parse(decoded.payload).specRevision === 3,
        observed: { sequence: decoded.sequence, stage: decoded.stage, payload: JSON.parse(decoded.payload) },
      };
    }),
  );

  yield* probe(
    "sqlite",
    "SQ5",
    "a failed transaction rolls back its durable intent",
    Effect.gen(function* () {
      const attempt = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO workflow_events ${sql.insert({ sequence: 99, stage: "rollback", payload: "{}" })}
            `;
            return yield* Effect.fail(new Error("bebop refused the event"));
          }),
        ),
      );
      const rows = yield* sql`SELECT sequence FROM workflow_events WHERE sequence = 99`;
      return {
        pass: Exit.isFailure(attempt) && rows.length === 0,
        observed: { transactionFailed: Exit.isFailure(attempt), rowsRemaining: rows.length },
      };
    }),
  );
});

/**
 * WAL's whole reason for being here: a second connection must be able to read while a
 * write transaction is open. If a reader blocks, Swordfish's status pane stalls behind
 * every event append.
 */
const walConcurrencyProbe = Effect.gen(function* () {
  const writer = yield* SqlClient.SqlClient;

  yield* probe(
    "sqlite",
    "SQ6",
    "a second connection reads while a write transaction is open",
    Effect.gen(function* () {
      const readDuringWrite = Effect.gen(function* () {
        const reader = yield* SqlClient.SqlClient;
        yield* reader`PRAGMA busy_timeout = 2000`;
        const rows = yield* reader`SELECT count(*) AS n FROM workflow_events`;
        return Number((rows[0] as { n: unknown }).n);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: sqlitePath })), Effect.timeout("3 seconds"), Effect.exit);

      // Open a write transaction, read from the other connection from inside it, commit.
      const duringCommit = yield* writer.withTransaction(
        Effect.gen(function* () {
          yield* writer`
            INSERT INTO workflow_events ${writer.insert({ sequence: 50, stage: "concurrent", payload: "{}" })}
          `;
          return yield* readDuringWrite;
        }),
      );

      const after = yield* writer`SELECT count(*) AS n FROM workflow_events`;
      const countAfter = Number((after[0] as { n: unknown }).n);
      const countDuring = Exit.isSuccess(duringCommit) ? duringCommit.value : null;

      return {
        pass: countDuring !== null && countDuring === countAfter - 1,
        observed: {
          readerOutcome: Exit.isSuccess(duringCommit) ? "read without blocking" : String(duringCommit.cause),
          countSeenDuringOpenTransaction: countDuring,
          countAfterCommit: countAfter,
        },
      };
    }),
  );
});

/**
 * Restart durability, in two steps that a spike can actually distinguish:
 * a clean reopen, and a reopen after the writing process was SIGKILLed mid-flight.
 */
const restartProbes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* probe(
    "sqlite",
    "SQ7",
    "rows written by a previous client are present after reopening the file",
    Effect.gen(function* () {
      const rows = yield* sql`SELECT sequence, stage FROM workflow_events ORDER BY sequence`;
      const integrity = yield* sql`PRAGMA integrity_check`;
      return {
        pass: rows.length >= 2 && String((integrity[0] as { integrity_check: unknown }).integrity_check) === "ok",
        observed: { rows, integrity: integrity[0] },
      };
    }),
  );

  yield* probe(
    "sqlite",
    "SQ8",
    "a transaction committed by a SIGKILLed process survives",
    Effect.gen(function* () {
      const { stdout, exitCode } = yield* Effect.promise(async () => {
        const child = spawn(["bun", `${here}/sigkill-child.ts`, sqlitePath, "77"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const text = await new Response(child.stdout).text();
        return { stdout: text, exitCode: await child.exited };
      });

      const rows = yield* sql`SELECT sequence, stage FROM workflow_events WHERE sequence = 77`;
      const outbox = yield* sql`SELECT sequence, acknowledged FROM bebop_outbox WHERE sequence = 77`;
      const integrity = yield* sql`PRAGMA integrity_check`;

      return {
        // The child must actually have died from the signal, not exited normally --
        // otherwise this probe proves nothing about unclean termination.
        pass:
          exitCode !== 0 &&
          stdout.includes("committed 77") &&
          rows.length === 1 &&
          outbox.length === 1 &&
          Number((outbox[0] as { acknowledged: unknown }).acknowledged) === 0,
        observed: {
          childExitCode: exitCode,
          childStdout: stdout.trim(),
          eventRows: rows.length,
          outboxRowUnacknowledged: outbox[0],
          integrity: integrity[0],
        },
      };
    }),
  );
});

// --- driver ------------------------------------------------------------------------

const compose = async (...args: Array<string>) => {
  const child = spawn(["docker", "compose", "-f", composeFile, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`docker compose ${args.join(" ")} failed (${code}):\n${stderr}`);
  return stdout.trim();
};

let started = false;

try {
  await rm(scratch, { recursive: true, force: true });
  await Bun.write(`${scratch}/.keep`, "");

  // Tear down first. If a previous run was interrupted before its own teardown, `up`
  // would silently adopt that container and every probe would then be measuring the
  // previous run's database -- migrations already applied, rows already present. A spike
  // that can inherit state cannot be trusted when it passes.
  process.stdout.write("starting ephemeral postgres...\n");
  await compose("down", "--volumes", "--remove-orphans");
  await compose("up", "--detach", "--wait");
  started = true;

  // Docker chose the host port; ask it which one rather than assuming 5432 is free.
  const mapping = await compose("port", "postgres", "5432");
  const port = Number(mapping.split(":").pop());
  const databaseUrl = `postgres://bebop:spike-password@127.0.0.1:${port}/bebop_spike`;
  process.stdout.write(`postgres: 127.0.0.1:${port}\n\n`);

  const pgLayer = PgClient.layerFrom(
    PgClient.make({
      url: Redacted.make(databaseUrl),
      // Swordfish and bebop both keep small pools; a spike that pooled 20 connections
      // would not be measuring the same thing the services will.
      maxConnections: 4,
    }),
  ).pipe(Layer.provideMerge(BunServices.layer));

  // BunServices is merged into both layers, not just Postgres: `Migrator.fromFileSystem`
  // carries a `FileSystem` requirement through the loader, so a SQLite migrator that reads
  // migration files needs a platform layer even though `SqliteMigrator.run` itself does not.
  const sqliteLayer = SqliteClient.layer({ filename: sqlitePath }).pipe(Layer.provideMerge(BunServices.layer));

  process.stdout.write("postgres (bebop-authoritative state)\n");
  await Effect.runPromise(postgresProbes.pipe(Effect.provide(pgLayer)));

  process.stdout.write("\nsqlite (swordfish-authoritative state)\n");
  await Effect.runPromise(sqliteProbes.pipe(Effect.provide(sqliteLayer)));
  await Effect.runPromise(walConcurrencyProbe.pipe(Effect.provide(sqliteLayer)));

  // A fresh layer is a fresh bun:sqlite handle: the equivalent of Swordfish restarting.
  await Effect.runPromise(restartProbes.pipe(Effect.provide(sqliteLayer)));

  await Bun.write(`${here}/results.json`, `${JSON.stringify({ databaseUrlPort: port, results }, null, 2)}\n`);

  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} probes passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((r) => r.id).join(", ")}\n`);
    process.exitCode = 1;
  }
} finally {
  if (started) {
    process.stdout.write("stopping postgres...\n");
    await compose("down", "--volumes", "--remove-orphans").catch((error: unknown) => {
      process.stdout.write(`warning: teardown failed, the next run will clean up: ${String(error)}\n`);
    });
  }
}
