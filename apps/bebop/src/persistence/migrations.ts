// Bebop's Postgres schema ("Postgres for bebop, SQLite for Swordfish" (ADR 0008)).
//
// Migrations are a static record rather than a directory read at runtime.
// `Migrator.fromFileSystem` loads each migration by dynamic import from a path, which does
// not survive `vp pack` — the packed bundle has no migrations directory beside it. A record
// of statically imported effects is fully analysable, so the bundle carries its own schema.
//
// Keys are `<id>_<name>`; the migrator sorts by id and records applied ids in
// `effect_sql_migrations`.

import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Bounty identity and the lifecycle state Bebop is authoritative for ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)).
  //
  // `status` is deliberately absent: the compact status in `docs/capabilities/01-bounty-lifecycle.md` is derived from
  // `lifecycle_state` plus the Swordfish stage, and storing a derived value invites the two
  // to disagree after a projection update that forgets to rewrite it.
  //
  // `swordfish_token_hash` is nullable because the bounty-scoped token is minted when the VM
  // is created and injected at its bootstrap ("Swordfish tokens are bounty-scoped" (ADR 0014)). A bounty that has a record
  // but no computer yet has nothing to authenticate.
  yield* sql`
    CREATE TABLE bounties (
      bounty_id             text PRIMARY KEY,
      repository            text NOT NULL,
      base_ref              text NOT NULL,
      assigned_branch       text NOT NULL,
      compute_profile       text NOT NULL,
      primary_context       jsonb NOT NULL,
      initial_prompt        text,
      lifecycle_state       text NOT NULL,
      lifecycle_detail      text,
      swordfish_token_hash  text UNIQUE,
      created_at            timestamptz NOT NULL,
      updated_at            timestamptz NOT NULL
    )
  `;
  yield* sql`CREATE INDEX bounties_created_at_idx ON bounties (created_at DESC, bounty_id DESC)`;

  yield* sql`
    CREATE TABLE vm_mappings (
      bounty_id    text PRIMARY KEY REFERENCES bounties (bounty_id) ON DELETE CASCADE,
      vm_id        text NOT NULL UNIQUE,
      ssh_host     text,
      ssh_port     integer,
      ssh_user     text,
      previews     jsonb NOT NULL,
      created_at   timestamptz NOT NULL,
      updated_at   timestamptz NOT NULL,
      destroyed_at timestamptz
    )
  `;

  yield* sql`
    CREATE TABLE api_tokens (
      token_id     text PRIMARY KEY,
      name         text NOT NULL UNIQUE,
      token_hash   text NOT NULL UNIQUE,
      created_at   timestamptz NOT NULL,
      last_used_at timestamptz,
      revoked_at   timestamptz
    )
  `;

  // The client-visible event log behind `GET /api/bounties/:id/events` (`docs/capabilities/01-bounty-lifecycle.md`).
  // The cursor is per bounty and dense, which is what makes `Last-Event-ID` replay exact.
  yield* sql`
    CREATE TABLE bounty_events (
      bounty_id   text NOT NULL REFERENCES bounties (bounty_id) ON DELETE CASCADE,
      cursor      bigint NOT NULL,
      occurred_at timestamptz NOT NULL,
      payload     jsonb NOT NULL,
      PRIMARY KEY (bounty_id, cursor)
    )
  `;

  // Every Swordfish event Bebop accepted, with the fingerprint computed at the protocol
  // boundary.
  //
  // The fingerprint has its own column because `jsonb` does not preserve key order (proved
  // by `prototypes/persistence`, PG4b). Recomputing it from `payload` on read would produce a
  // different hash than the one taken over the wire, and every replay would then look like a
  // conflicting replay.
  yield* sql`
    CREATE TABLE swordfish_events (
      bounty_id   text NOT NULL REFERENCES bounties (bounty_id) ON DELETE CASCADE,
      sequence    bigint NOT NULL,
      vm_id       text NOT NULL,
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      fingerprint text NOT NULL,
      payload     jsonb NOT NULL,
      PRIMARY KEY (bounty_id, sequence)
    )
  `;

  // The durable projection ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)). `snapshot` carries the workflow core; the
  // columns beside it are the fields Bebop queries, sweeps, or lists on.
  yield* sql`
    CREATE TABLE swordfish_projections (
      bounty_id              text PRIMARY KEY REFERENCES bounties (bounty_id) ON DELETE CASCADE,
      vm_id                  text NOT NULL,
      connection_id          text,
      freshness              text NOT NULL,
      last_observed_at       timestamptz,
      stage                  text,
      last_produced_sequence bigint NOT NULL,
      last_applied_sequence  bigint NOT NULL,
      snapshot               jsonb NOT NULL,
      updated_at             timestamptz NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX swordfish_projections_freshness_idx
      ON swordfish_projections (freshness, last_observed_at)
  `;

  // The durable command queue ("Swordfish connects outbound only" (ADR 0013)). A command survives Swordfish being
  // offline and is delivered on reconnect; `command_id` is the deduplication key on both
  // sides.
  yield* sql`
    CREATE TABLE bounty_commands (
      command_id         text PRIMARY KEY,
      bounty_id          text NOT NULL REFERENCES bounties (bounty_id) ON DELETE CASCADE,
      command            jsonb NOT NULL,
      issued_at          timestamptz NOT NULL,
      delivered_at       timestamptz,
      status             text NOT NULL,
      result_reported_at timestamptz,
      error              text
    )
  `;
  yield* sql`
    CREATE INDEX bounty_commands_pending_delivery_idx
      ON bounty_commands (bounty_id, issued_at)
      WHERE status IN ('queued', 'delivered')
  `;

  // SHA-pinned privileged-path approvals ("`.bebop/**` is permanently privileged" (ADR 0011)).
  yield* sql`
    CREATE TABLE config_approvals (
      bounty_id     text NOT NULL REFERENCES bounties (bounty_id) ON DELETE CASCADE,
      candidate_sha text NOT NULL,
      approved_at   timestamptz NOT NULL,
      PRIMARY KEY (bounty_id, candidate_sha)
    )
  `;

  // Idempotency keys ("Postgres for bebop, SQLite for Swordfish" (ADR 0008)). `request_fingerprint` is what makes a reused key
  // carrying a different request a conflict rather than a silent alias for the first one.
  yield* sql`
    CREATE TABLE idempotency_keys (
      scope               text NOT NULL,
      idempotency_key     text NOT NULL,
      request_fingerprint text NOT NULL,
      bounty_id           text REFERENCES bounties (bounty_id) ON DELETE CASCADE,
      created_at          timestamptz NOT NULL,
      PRIMARY KEY (scope, idempotency_key)
    )
  `;

  // Durable background work for `bebop-worker` (`docs/capabilities/15-deployment-and-operation.md`: "durable job rows in
  // Postgres worked by Effect fibers"). `dedupe_key` is what stops one idempotent create
  // from enqueuing two provisioning runs.
  yield* sql`
    CREATE TABLE lifecycle_jobs (
      job_id      text PRIMARY KEY,
      dedupe_key  text NOT NULL UNIQUE,
      bounty_id   text NOT NULL REFERENCES bounties (bounty_id) ON DELETE CASCADE,
      kind        text NOT NULL,
      payload     jsonb NOT NULL,
      status      text NOT NULL,
      attempts    integer NOT NULL,
      run_after   timestamptz NOT NULL,
      locked_by   text,
      locked_at   timestamptz,
      last_error  text,
      created_at  timestamptz NOT NULL,
      updated_at  timestamptz NOT NULL
    )
  `;
  yield* sql`CREATE INDEX lifecycle_jobs_ready_idx ON lifecycle_jobs (status, run_after)`;
});

const bebopMigrations = { "1_initial": initial } as const;

export const bebopMigrationLoader: Migrator.Loader = Migrator.fromRecord(bebopMigrations);
