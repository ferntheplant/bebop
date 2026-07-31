# Gotchas

Environment behaviour that looks like a defect in our code and is not. Nothing here was chosen — the runtime,
the driver, or the toolchain chose it for us, which is why none of it is an [ADR](./adr/).

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

## Credentials in the environment

**A seat credential must never reach the tmux session environment or a shell profile.** `opencode attach`
defaults `--password` to `OPENCODE_SERVER_PASSWORD`, so an inherited variable silently re-grants seat write
access to every free shell pane in the cockpit — defeating
[the control lease](./adr/0009-the-control-lease-is-enforced-in-four-layers.md) without any command looking
wrong. The credential is passed only to the processes Swordfish itself spawns.

## Process lifecycle

**A graceful `server.stop()` can wait forever.** A WebSocket whose close handshake is in flight when the server
stops accepting reproduces it every time, which would hang the blue/green drain on every deploy. Bebop bounds
`server.stop()` with `shutdownTimeout`; Swordfish closes its scope in a detached fiber and abandons finalizers
exceeding `SWORDFISH_SHUTDOWN_TIMEOUT`, so a stuck socket close cannot outlive the supervisor's grace period.

**`httpIdleTimeout` defaults to Bun's maximum of 255 seconds rather than being disabled.** An unbounded idle
connection is a resource a half-dead client can hold forever, and the event stream is resumable by construction —
a dropped subscriber reconnects with `Last-Event-ID` and misses nothing.
