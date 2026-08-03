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
  yield* sql`
    CREATE TABLE constraint_ledger (
      constraint_key      text PRIMARY KEY,
      consumed            integer NOT NULL,
      limit_value         integer NOT NULL,
      extensions_granted  integer NOT NULL,
      updated_at          text NOT NULL
    )
  `;
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

export const swordfishMigrations = { "1_initial": initial } as const;
export const swordfishMigrationLoader: Migrator.Loader = Migrator.fromRecord(swordfishMigrations);
