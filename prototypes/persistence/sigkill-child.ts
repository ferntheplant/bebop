// Child process for the "killed after commit, before acknowledgement" probe.
//
// It commits a workflow event and its outbox row in one transaction, then SIGKILLs itself
// without closing the database, unwinding a scope, or flushing anything. The parent then
// reopens the same file and asks whether the commit survived.
//
// This is the durability half of Milestone 4's exit criterion "killing Swordfish after
// committing an event but before acknowledgement causes a safe replay after restart".
// The workflow half belongs to Milestone 4; what has to be true first is that Bun's SQLite
// in WAL mode does not lose a committed transaction when the process dies uncleanly.

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const [databasePath, sequenceArgument] = process.argv.slice(2);

if (databasePath === undefined || sequenceArgument === undefined) {
  throw new Error("usage: sigkill-child.ts <database-path> <sequence>");
}

const sequence = Number(sequenceArgument);

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO workflow_events ${sql.insert({
          sequence,
          stage: "candidate_submitted",
          payload: JSON.stringify({ candidateSha: "b0b0b0b0", killedBeforeAcknowledgement: true }),
        })}
      `;
      yield* sql`INSERT INTO bebop_outbox ${sql.insert({ sequence, acknowledged: 0 })}`;
    }),
  );

  // The commit has returned. Anything after this line is work Swordfish would have done
  // before telling bebop about the event -- and it never happens.
  process.stdout.write(`committed ${sequence}\n`);
  process.kill(process.pid, "SIGKILL");

  // Unreachable; kept so the effect has a terminal value if SIGKILL were ever deferred.
  yield* Effect.sleep("5 seconds");
}).pipe(Effect.provide(SqliteClient.layer({ filename: databasePath })));

await Effect.runPromise(program);
