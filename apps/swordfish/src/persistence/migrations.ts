// Swordfish's complete local authority schema. Migrations are statically imported so the
// packed daemon carries them instead of looking for source files beside `dist/daemon.mjs`.

import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE workflow_state (
      singleton       integer PRIMARY KEY CHECK (singleton = 1),
      state_revision  integer NOT NULL,
      snapshot        text NOT NULL,
      updated_at      text NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE workflow_events (
      sequence       integer PRIMARY KEY,
      occurred_at    text NOT NULL,
      fingerprint    text NOT NULL,
      payload        text NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE bebop_outbox (
      sequence       integer PRIMARY KEY REFERENCES workflow_events (sequence),
      payload        text NOT NULL,
      acknowledged  integer NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
      acknowledged_at text
    )
  `;
  yield* sql`CREATE INDEX bebop_outbox_pending_idx ON bebop_outbox (sequence) WHERE acknowledged = 0`;

  // Keyed by seat, not by role. Ein's seat is reused for context continuity, but every jet and faye attempt
  // gets a fresh one, and the finished ones stay listed as inspectable provenance ("One controller drives one
  // active cowboy" (ADR 0037)) — a role-keyed table overwrote exactly that history. There is no lease owner
  // column because who is driving is one workflow-wide value, not a property of each seat.
  yield* sql`
    CREATE TABLE seats (
      seat_id       text PRIMARY KEY,
      role          text NOT NULL,
      created_at    text NOT NULL,
      updated_at    text NOT NULL
    )
  `;
  yield* sql`CREATE INDEX seats_role_idx ON seats (role, created_at)`;
  yield* sql`
    CREATE TABLE effective_specs (
      revision      integer PRIMARY KEY,
      payload       text NOT NULL,
      created_at    text NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE candidates (
      commit_sha     text NOT NULL,
      spec_revision  integer NOT NULL,
      payload        text NOT NULL,
      submitted_at   text NOT NULL,
      invalidated_at text,
      PRIMARY KEY (commit_sha, spec_revision)
    )
  `;
  // There is deliberately no constraint ledger table. Attempts, turns, and wall clock are derived from the
  // event stream by the same reducer Bebop's projection runs, so they live in the workflow snapshot
  // ("Constraint exhaustion is computed, not announced" (ADR 0042)) — a second copy in its own table is exactly
  // the derived state the architectural rules forbid storing, and the first missed update would leave it
  // permanently wrong. The table this replaces was also keyed by a flat constraint name with no scope, so
  // nothing in it ever reset at a build cycle or a candidate.
  yield* sql`
    CREATE TABLE validator_outcomes (
      sequence       integer PRIMARY KEY REFERENCES workflow_events (sequence),
      gate           text NOT NULL,
      candidate_sha  text NOT NULL,
      spec_revision  integer NOT NULL,
      outcome        text NOT NULL,
      payload        text,
      occurred_at    text NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE findings (
      finding_id     integer PRIMARY KEY AUTOINCREMENT,
      event_sequence integer NOT NULL REFERENCES workflow_events (sequence),
      gate           text NOT NULL,
      payload        text NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE local_artifacts (
      artifact_id    text PRIMARY KEY,
      candidate_sha  text,
      manifest       text NOT NULL,
      created_at     text NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE applied_commands (
      command_id      text PRIMARY KEY,
      command_hash    text NOT NULL,
      command_payload text NOT NULL,
      result_payload  text NOT NULL,
      applied_at      text NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE reconciliation_records (
      record_id       text PRIMARY KEY,
      kind            text NOT NULL,
      path            text,
      pid             integer,
      status          text NOT NULL,
      detail          text,
      updated_at      text NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE daemon_metadata (
      singleton                integer PRIMARY KEY CHECK (singleton = 1),
      bounty_id                text NOT NULL,
      vm_id                    text NOT NULL,
      repository               text NOT NULL,
      assigned_branch          text NOT NULL,
      acknowledged_through     integer NOT NULL,
      last_contact_at          text,
      last_applied_command_id  text,
      connected                integer NOT NULL CHECK (connected IN (0, 1))
    )
  `;
});

// `connected` was a compact status written to a column, which the architectural rules forbid:
// derivable state is derived on read. The live connection is now held in memory by the reconnect
// loop, which is its only writer, and read on demand by the control socket — so the column is not
// replaced by another one, it is removed. Migration 1 keeps creating it because it already ran on
// databases in the field; changing it there would leave those databases with a column no insert
// supplies.
const dropDaemonConnected = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE daemon_metadata DROP COLUMN connected`;
});

const swordfishMigrations = { "1_initial": initial, "2_drop_daemon_connected": dropDaemonConnected } as const;
export const swordfishMigrationLoader: Migrator.Loader = Migrator.fromRecord(swordfishMigrations);
