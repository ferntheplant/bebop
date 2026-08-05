# The local-system worker sometimes exits 1 before the first health assertion

`test/local-system/harness.test.ts` fails on CI roughly intermittently at the first scenario:

```
AssertionError: expected 1 to be null
 ❯ test/local-system/harness.test.ts:389   expect(worker.child.exitCode).toBeNull();
```

`waitForHealth` had already returned and the API was fine, so only the worker died — within about 2.4s of
starting. A rerun passed. This flake has been chased before.

Two things a light look turned up.

**The assertion throws away the evidence.** `fleet.start` already accumulates each child's stdout and stderr and
exposes it as `output()`, but the exit-code assertions don't include it, so a CI failure reports that the worker
died and nothing about why. That is likely why previous attempts went nowhere: every occurrence teaches nothing.
Putting `worker.output()` in the assertion message is a one-line change and would make the next occurrence
diagnosable.

**Prime suspect: the concurrent migration race, with the worker on the losing side.** `runBebopWorker` wraps its
tick loop in `Effect.catchCause`, so a bad job cannot kill it — `yield* migrateDatabase` is the only unguarded
step before that loop, which matches a process that exits 1 early and never logs "bebop worker started". The
harness starts the worker, waits 100ms, then starts the API, and both call `migrateDatabase`.
`apps/bebop/src/persistence/database.ts` claims the migrator takes an `ACCESS EXCLUSIVE` lock and treats a losing
racer as already-running rather than as an error; that claim was not verified here. If it does not hold in every
case, the observed timing dependence follows: on a fast machine the worker's 100ms head start makes it the
winner, and on a starved runner where bun startup exceeds the gap the API wins and the _worker_ takes the loser
path.

Not ruled out, just not investigated: anything else in `BebopRuntimeLayer` construction that runs before the
loop. Postgres readiness was ruled out — `createDisposableDatabase` runs `CREATE DATABASE` over an admin
connection before the fleet starts, so the server was answering queries.

Triage after the diagnostics land, not before — the fix depends on what the worker's output says.
