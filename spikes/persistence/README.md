# Spike: Postgres and SQLite persistence on the pinned Bun

**Status:** Complete — assumption **confirmed**, with two behaviours the contracts must account for

**Date:** 2026-07-26

**Pinned versions:** Bun 1.3.14, `effect@4.0.0-beta.101`, `@effect/sql-pg@4.0.0-beta.101`,
`@effect/sql-sqlite-bun@4.0.0-beta.101`, `@effect/platform-bun@4.0.0-beta.101`, `postgres:17-alpine`

**Assumption under test:** [`SPEC.md`](../../SPEC.md) §25 — `@effect/sql-pg` with its Migrator for bebop and
`@effect/sql-sqlite` for Swordfish, on TypeScript/Bun.

**PLAN reference:** Milestone 0, "Verify Effect HTTP, Postgres, SQLite, WebSocket, and CLI packages work on the
selected Bun version", and the exit criterion "a small Effect process round-trips one row through Postgres and
SQLite".

## Verdict

**Confirmed.** One Effect process on Bun 1.3.14 round-trips durable state through both stores. 16/16 probes
pass, repeatably, with no leaked containers, ports, or files.

The exit criterion asks only for a round trip. A bare insert-then-select would have satisfied that sentence
while leaving every property Milestones 3 and 4 actually rest on unproven, so the probes also pin down
migration idempotency, transaction rollback, error typing, integer fidelity, WAL concurrency, and crash
durability. Two of those answers change what the contracts have to say.

| Probe | Question                                                       | Result                                          |
| ----- | -------------------------------------------------------------- | ----------------------------------------------- |
| PG1   | Migrator applies migrations from the filesystem                | 2 applied                                       |
| PG2   | re-running the migrator is a no-op                             | 0 applied                                       |
| PG3   | one row round-trips and decodes into a domain value            | decoded                                         |
| PG4   | `jsonb` round-trips an event payload with its values intact    | deep-equal                                      |
| PG4b  | `jsonb` does **not** preserve key order                        | **reordered** — see finding 2                   |
| PG5   | a `bigint` sequence above 2^53 survives without losing digits  | exact, **returned as `string`** — see finding 3 |
| PG6   | a failed transaction rolls back its durable intent             | 0 rows remaining                                |
| PG7   | a unique violation is a typed `SqlError`, not a defect         | typed `UniqueViolation`                         |
| SQ1   | the database opens in WAL mode with a busy timeout             | `wal`, 5000 ms                                  |
| SQ2   | Migrator applies migrations from the filesystem                | 2 applied                                       |
| SQ3   | re-running the migrator is a no-op                             | 0 applied                                       |
| SQ4   | one workflow event round-trips and decodes into a domain value | decoded                                         |
| SQ5   | a failed transaction rolls back its durable intent             | 0 rows remaining                                |
| SQ6   | a second connection reads while a write transaction is open    | read without blocking                           |
| SQ7   | rows survive reopening the file; `integrity_check`             | `ok`                                            |
| SQ8   | a transaction committed by a **SIGKILLed** process survives    | exit 137, row present, `integrity_check` `ok`   |

## Findings

### 1. The Effect 4 beta line ships its own drivers and platform layer (confirmed)

`@effect/sql-pg`, `@effect/sql-sqlite-bun`, and `@effect/platform-bun` all publish `4.0.0-beta.101` — the exact
version the root catalog pins for `effect`. This is the resolution of the open question left by Milestone 2's
note that "adding current Effect 3 `@effect/platform` or `@effect/cli` packages would create an incompatible
peer-dependency stack": the constraint is against the Effect **3** packages, not against `@effect/*` generally.
The beta-line packages install cleanly and are now pinned in the root catalog.

Bun prints `warn: incorrect peer dependency "effect@4.0.0-beta.101"` on install. The declared peer range is
`^4.0.0-beta.101` and the installed version is exactly `4.0.0-beta.101`, which satisfies it; this is Bun's
caret-versus-prerelease handling, not a real mismatch. Nothing fails.

`SqlClient`, `Migrator`, `Statement`, and `SqlError` live in core as `effect/unstable/sql`; only the driver and
the platform services come from separate packages.

### 2. `jsonb` normalises the document, so fingerprints must not be recomputed from a read (new)

Values survive a `jsonb` round trip exactly (PG4). The **byte layout does not** (PG4b):

```text
original key order : ["candidateSha","specRevision","findings"]
stored key order   : ["findings","candidateSha","specRevision"]
re-serialised bytes match original: false
```

This is documented Postgres behaviour — `jsonb` is a parsed representation, not the source text — but it
collides with a Milestone 2 decision. Reducers "retain fingerprints for every applied sequence so conflicting
replay fails closed". If a fingerprint is computed by re-serialising a payload read back from `jsonb`, it will
not match the fingerprint computed over the wire bytes, and **every replay would look like a conflict**.

Consequence: fingerprints must be computed once, at the protocol boundary, and stored in their own column.
Alternatively the payload column becomes `json` (which does preserve text) — but `json` gives up indexing and
containment operators, so a dedicated fingerprint column is the better trade. Either way this is a decision, not
an implementation detail, and it belongs in the contracts.

### 3. `bigint` comes back as a string (new)

PG5 stored `9007199254740993` (2^53 + 1) and read it back exactly — as a JavaScript **`string`**, not a number
and not a `bigint`. `node-postgres` refuses to narrow `int8` to a double, which is the correct choice and the
reason no digits were lost.

Consequence for Milestone 3: any schema decoding a sequence number, cursor, or acknowledgement offset out of
Postgres must accept the encoded form as a string. A schema written as `Schema.Number` against a `bigint`
column will fail to decode at the repository boundary — a failure that only shows up once real sequence numbers
exist, which is exactly the sort of thing this spike is for. `SqlClient.SafeIntegers` exists as a reference if
`bigint` values are wanted instead; the string form is fine and is what the probe records.

### 4. SQLite defaults are already the ones Swordfish wants (confirmed)

`SqliteClient.layer` opens in WAL mode unless `disableWAL: true` is passed (SQ1), so Milestone 4's "WAL
configuration" work is a matter of confirming rather than enabling it. `busy_timeout` is not set by default and
must be issued as a pragma on each connection.

WAL delivers the property it is there for: with a write transaction open on one connection, a second connection
read the pre-commit state immediately rather than blocking (SQ6, `countSeenDuringOpenTransaction=1`,
`countAfterCommit=2`). Swordfish's status pane will not stall behind event appends.

### 5. A committed transaction survives SIGKILL (confirmed)

SQ8 is the durability half of Milestone 4's exit criterion "killing Swordfish after committing an event but
before acknowledgement causes a safe replay after restart". A child process commits a workflow event and its
outbox row in one transaction, then SIGKILLs itself before doing anything else:

```text
child exit code            : 137   (128 + SIGKILL)
child stdout               : "committed 77"
event row after reopen     : present
outbox row after reopen    : { sequence: 77, acknowledged: 0 }
PRAGMA integrity_check     : ok
```

The event is durable and still unacknowledged, which is precisely the state a restart must be able to replay
from. The workflow half — that Swordfish _does_ replay it — belongs to Milestone 4; what had to be true first is
that Bun's SQLite does not lose the commit, and it does not.

### 6. `Migrator.fromFileSystem` pulls a platform requirement through the loader (confirmed)

`SqliteMigrator.run`'s signature mentions only `SqlClient | R2`, but `Migrator.fromFileSystem` is a
`Loader<FileSystem>`, so `R2` carries a `FileSystem` requirement. A SQLite migrator reading migration files
therefore needs `BunServices.layer` even though the SQLite client itself has no platform dependency.
`PgMigrator.run` additionally requires `ChildProcessSpawner` and `Path` — it shells out to `pg_dump` when
`schemaDirectory` is set — so bebop needs the platform layer regardless.

Migration files are loaded by dynamic `import`, which works under Bun for `.ts` sources. `vp pack` produces a
bundle rather than a directory of loose migration modules, so **the packaged services should switch to
`Migrator.fromGlob`**, whose imports are statically analysable. `fromFileSystem` is right for the spike and for
tests; it is not right for the single-binary Swordfish in SPEC §25.

### 7. A spike that can inherit state cannot be trusted when it passes (process finding)

The first full run reported five Postgres failures that were not real: an earlier invocation had been killed
before its teardown ran, and `docker compose up` silently adopted the surviving container, so the probes were
measuring a database that had already been migrated and populated. The driver now tears down **before** it
brings Postgres up, so an interrupted run cannot make a later run lie in either direction.

The same rule applies to the integration suites in Milestones 3 and 5.

## Running it

Requires a working Docker daemon. No credentials and no network access beyond pulling `postgres:17-alpine`.

```bash
vp run @bebop/spike-persistence#spike
```

Exits nonzero if any probe fails. Writes `results.json` (per-probe observations) next to this file; both
`results.json` and the `.spike/` scratch directory are gitignored. Postgres runs on a Docker-allocated host port
with `tmpfs` storage, and the SQLite database is recreated from scratch on every run.

## Layout

| Path                 | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `run.ts`             | Driver: brings up Postgres, runs all 16 probes, reports and tears down    |
| `sigkill-child.ts`   | Commits a transaction and SIGKILLs itself, for the crash-durability probe |
| `compose.yml`        | Ephemeral Postgres on a Docker-allocated port with `tmpfs` storage        |
| `migrations/pg/`     | Bebop-authoritative tables (SPEC §22.1)                                   |
| `migrations/sqlite/` | Swordfish-authoritative tables (SPEC §22.2)                               |

This is a spike, not product code. The real repositories land in `apps/bebop` during Milestone 3 and
`apps/swordfish` during Milestone 4.
