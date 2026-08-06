# Gotchas

Behaviour that looks like a defect in our code and is not. Most of it was not chosen — the runtime, the driver,
or the toolchain chose it for us, which is why none of it is an [ADR](./adr/). The rest is deliberately deferred:
a weaker mechanism than the obvious one, standing until a decision that has not been taken yet.

Each entry names the obvious-looking simplification that reintroduces the problem. That is the point of the
file: every one of these has already been shipped once, and every one of them looks like tidiness to someone
who did not hit it.

## Build and packaging

**No task may name a built artifact directly.** Vite+ resolves a bare `./dist/*.mjs` command as a binary at
**plan** time, before any task runs, so a task naming one fails before the build that would produce it. The
artifact smokes go through `apps/bebop/scripts/smoke.ts` instead — which also lets them assert something worth
asserting: that each packed bundle loads and reaches its own code, proved by the servers reporting a
configuration error and the CLI printing its usage. A missing dependency or a dynamic import that did not
survive bundling fails there, and none of that is visible from a type check.

**`check` and the test tasks depend on `build`.** They resolve `@bebop/contracts` through its built `dist`, so
running them on a clean checkout without the dependency edge finds a stale package or none at all.

**The root `build` task names every package build instead of running `vp run -r build`.** A nested `vp run` is
_inlined_ by Vite Task as fresh task nodes, and those do not dedupe against the same builds reached through the
`dependsOn: { task: "build", from: [...] }` closure the artifact smokes use. `ready` therefore scheduled every
package's build twice, and two `vp pack` processes running concurrently in one directory empty `dist` under
each other — surfacing as `Cannot find module '@bebop/contracts'` inside a smoke rather than as a build
failure. Listing the task IDs keeps one node per build and drops `ready` from twenty tasks to fifteen. This was
previously worked around with `VP_RUN_CONCURRENCY_LIMIT: "1"` in CI, which is no longer needed. Collapsing the
list back into `vp run -r build` is the tidying that reintroduces the race, and it reintroduces it silently:
the duplicate scheduling is always present, but whether it corrupts a build depends on machine timing, so it
passes locally and fails on a CI runner with a different core count.

**Quiet builds take two log settings, and neither of them belongs in the root config.** `vp pack` resolves the
_nearest_ `vite.config.ts` and never merges the root's `pack` block — only `lint` and `fmt` take root-level
defaults — so a `logLevel` set once at the root is dead config. Each package sets its own `pack.logLevel`,
which quiets the per-build logger: entry, tsconfig, the size report, `Build complete`. The remaining
`Build start` and `Cleaning N files` go through tsdown's `globalLogger`, whose level is assigned only inside
`build()` — and the `vp pack` CLI bypasses that by calling the internal `buildWithConfigs()` directly, so
neither a config key nor `-l silent` reaches it. Each config therefore imports `globalLogger` from
`vite-plus/pack` and sets the level itself at load time, which lands because Vite+ loads the config in-process
before the build starts. Both are needed; they are separate logger instances, and deleting either restores its
half of the noise. The bypass is an upstream defect pinned to the vendored Vite+ version, so this comes off
when `vp pack` starts routing through `build()`.

**`vitest` is a direct devDependency pinned to the version Vite+ vendors.** The two must be upgraded together.
That coupling is the one way [the Bun-launched runner](./adr/0020-vitest-is-launched-by-bun.md) can drift.

## Imports and runtime

**The stack is pinned together on the Effect 4 beta line.** Platform APIs live under `effect/unstable/*`, and
adding an Effect 3 `@effect/platform` or `@effect/cli` package creates an incompatible peer-dependency stack.
`@effect/sql-pg`, `@effect/sql-sqlite-bun`, and `@effect/platform-bun` are pinned at the matching version in the
root catalog and move together.

**`@effect/platform-bun` must be imported by submodule, never through its barrel.** The barrel re-exports
`BunRedis` and therefore imports the `bun` module at load time, making anything that touches it unloadable
wherever Bun is not the runtime. Tidying these imports back to the barrel breaks loading, not type checking, so
it fails late and in a confusing place.

**`node:crypto` is used for hashing, not `Bun.hash`.** It works under both runtimes, and hashing is not where a
Bun-specific API earns its keep.

**Both CLIs must supply `BunStdio.layer` explicitly.** `Command.run` reads argv from the `Stdio` service, which
`BunRuntime.runMain` does not provide. Without it every invocation fails at startup, including `--help`.

## Persistence

Found by the [persistence prototype](../prototypes/persistence/README.md). Each fails in production data rather
than in a type check.

**`sql.json` mis-encodes a JavaScript array.** The driver writes it as a Postgres array literal, which Postgres
rejects for a `jsonb` column with `invalid input syntax for type json`. Objects survive, which is what makes it
easy to ship — `primary_context` and the preview list are arrays and nothing else would have noticed. Every
`jsonb` write goes through `jsonbParameter` with an explicit `::jsonb` cast.

**`jsonb` does not preserve key order.** An event fingerprint recomputed from a payload read back out of `jsonb`
would differ from the one computed when it arrived, so every replay would look like a conflict. Fingerprints are
computed once when the message is decoded and stored in their own column, never recomputed on read.

**`bigint` decodes as a JavaScript string.** Values are exact, but any schema reading a sequence number, cursor,
or acknowledgement offset must accept the string encoding rather than `Schema.Number`.

**Migrations load from a static record, not a directory.** `Migrator.fromFileSystem` loads by dynamic import and
does not survive `vp pack`. Adding a migration means editing the record — the one step a contributor coming from
a conventional migration tool will miss. `fromFileSystem` remains fine in tests, which never run packed.

**Effect's migration table lock does not protect creation of the migration table itself.** `PgMigrator.run`
checks for and creates `effect_sql_migrations` before opening the transaction where it takes
`ACCESS EXCLUSIVE`; two processes starting against a fresh database can both observe no table and collide in
Postgres's `pg_type` catalog with a `23505` unique violation. `migrateDatabase` therefore creates the metadata
table under a transaction-scoped advisory lock before handing control to Effect. Replacing that bootstrap with a
direct `PgMigrator.run` call reintroduces the race even though the migrator still appears to lock correctly.

The race was diagnosable only after process exit assertions included the child's captured output. For a rare
startup race, first amplify the real process seam with several isolated concurrent pairs, then minimize the
failure at the narrowest faithful interface — here, two independent clients calling `migrateDatabase` against
one fresh database produced the same catalog violation deterministically in under a second. Repeatedly rerunning
the full suite without preserving process output produces confidence or frustration, not evidence.

## Credentials in the environment

**A seat credential must never reach the tmux session environment or a shell profile.** `opencode attach`
defaults `--password` to `OPENCODE_SERVER_PASSWORD`, so an inherited variable silently re-grants seat write
access to every free shell pane in the cockpit — defeating
[The control lease blocks mixed model turns, not trusted cockpit input (ADR 0039)](./adr/0039-the-control-lease-blocks-mixed-model-turns-not-trusted-cockpit-input.md)
without any command looking wrong. Isolated seat credentials are the layer that stops an ambient second client
from driving a seat, so leaking one removes the protection rather than weakening it. The credential is passed
only to the processes Swordfish itself spawns.

**`BEBOP_LOCAL_HARNESS_ROOT` makes every provision write a Swordfish machine credential to disk in plaintext.**
That is the whole point of it locally and a deployment accident anywhere else, so setting it logs a warning at
startup rather than starting quietly. The warning is a recorded compromise, not a guard — nothing stops the
variable being set in production, and whether it should be impossible there rather than merely loud is still
open. Deleting the warning as startup noise removes the only signal that a deployment has it on.

## Process lifecycle

**A graceful `server.stop()` can wait forever.** A WebSocket whose close handshake is in flight when the server
stops accepting reproduces it every time, which would hang the blue/green drain on every deploy. Bebop bounds
`server.stop()` with `shutdownTimeout`; Swordfish closes its scope in a detached fiber and abandons finalizers
exceeding `SWORDFISH_SHUTDOWN_TIMEOUT`, so a stuck socket close cannot outlive the supervisor's grace period.

**`httpIdleTimeout` defaults to Bun's maximum of 255 seconds rather than being disabled.** An unbounded idle
connection is a resource a half-dead client can hold forever, and the event stream is resumable by construction —
a dropped subscriber reconnects with `Last-Event-ID` and misses nothing.

**The bounty event stream sends no keep-alive, so an idle reader is closed by Bun rather than by us.** Depending
on whether the client's own abort or Bun's idle close wins the race, `fetch` reports an `AbortError` or a
socket-close `TypeError`; a bounded read has to treat both as the normal end once bytes have arrived. It is also
why any suite reusing a pooled keep-alive socket sets `BEBOP_HTTP_IDLE_TIMEOUT` generously — a short window plus
a starved CI runner produced `ECONNRESET` flakes in the component suites. Whether the stream should emit a
keep-alive, and what that does to the SSE contract, is still open. Narrowing the catch to one error type, or
tightening the timeout because thirty seconds looks excessive, are the two tidyings that reintroduce it, and both
fail only under load.

**The Swordfish control socket accepts connections before anything answers on them.** `makeControlSocket` binds
the listener first, then `initializeDatabase` and `workflow.bootstrap` run, and only then is `runControlServer`
forked. That order is deliberate: the listener is how a second daemon on the same database is refused _before_
reconciliation mutates state, which is what `apps/swordfish/src/daemon.ts` acquires both listeners up front to
guarantee. Nothing is dropped in the meantime — `NodeSocketServer.make` queues arriving connections and `run`
replays them — so a client simply waits, well inside its own response timeout. The consequence is that **the
socket file existing is not the daemon being ready**, and neither is a connection succeeding. Measured on an
idle machine the parked window is 16–309ms; on a loaded runner it is longer. Waiting on `lstat(path).isSocket()`
is the tidying that reintroduces this, and it reintroduces it as a timeout in whatever request happens to go
first. Wait on an answered control request instead — `waitForSwordfishControl` in `@bebop/testkit` is that wait.

## Static analysis

**A `_tag` field on a hand-rolled `Error` subclass is read by the type checker, not by the program, and dead-code
analysis is right that nothing reads it.** TypeScript is structurally typed, so with no other members declared,
deleting `_tag` from `InvalidSfControlRequestError`, `InvalidSfControlResponseError`, and
`UnexpectedSfControlResponseError` made all three mutually assignable and let a bare `new Error()` satisfy every
one of them. The field is a nominal brand. Runtime discrimination is `instanceof` throughout this codebase, so
nothing reads `_tag` at runtime and no reachability analysis can see the read. `.fallowrc.json` models this with
one `usedClassMembers` rule scoped to `extends: "Error"` rather than a suppression per class. Deleting the field
because the tool says it is unused is the tidying that reintroduces this, and it fails as a silently widened
type rather than as a build error.
