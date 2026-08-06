---
type: grilling
status: open
---

# Should the scheduled Effect loops be virtualized with `TestClock`?

Resolving this updates [Recovery and reliability](../../docs/capabilities/13-recovery-and-reliability.md).

## Question

The component suites use real wall-clock waits for what are really Effect `Schedule` loops. `TestClock` is the
first-party tool for removing them, and the repo does not use it anywhere. The analysis below was written as a
standing note; the decision was never made.

**The two cases where it would help.**

1. _Command delivery poll loop._ `apps/bebop/src/swordfish-gateway/gateway.ts` forks a scoped
   `Effect.repeat(Schedule.spaced(config.commandPollInterval))` loop. `commandPollInterval` defaults to 2s and
   the harness sets 150ms, and `gateway.test.ts` ends several assertions with a real
   `await new Promise((resolve) => setTimeout(resolve, 300))` (lines 204, 395, 413, 515, 581). The peer is a
   real WebSocket on a real port, but the _effect side_ of that loop is one in-process fiber — exactly what
   `TestClock` virtualizes.
2. _Bearer credential retry schedule._ `apps/bebop/src/api/authentication.ts:33-35` runs
   `Schedule.exponential(5ms, 2)` bounded to 60ms, exercised today only indirectly through the real server. A
   standalone unit test against an in-memory token store returning a transient `SqlError`, driven by
   `TestClock.adjust`, would catch a regression in the retry policy without standing up the stack.

**Why the wholesale refactor does not pay.**

- `Identity` bundles seven generators including `now`; `TestClock` virtualizes only `now`, so it is additive
  alongside `fixedIdentityLayer`, not a replacement.
- `fixedIdentityLayer.now` is an authoring counter that advances by `stepMillis` on _every read_.
  `TestClock.now` moves only on `adjust`, so preserving current semantics means inserting `adjust` at every
  read site — strictly more glue.
- The harness deliberately crosses process and socket seams: real `BunHttpServer`, real Postgres, real
  WebSocket peer. `TestClock` reaches in-process fibers only, so a partly-virtualized system is the worst
  case — the Effect side fires instantly while the external observer still needs real waits. The 300ms waits
  would shrink, not disappear.
- Most sleeps are not the scheduler's fault: 10ms settle waits for the WS adapter to dispatch frames, a 2.7s
  wait for the SSE client to reconnect past the server's idle timeout, SSE poll catch-up waits, a test-level
  deadline. `TestClock` reaches none of them.
- `Effect.sleep`/`Schedule` also runs in spawned-child integration tests, where no `TestClock` story exists at
  all.
- Domain, persistence, and contract suites take explicit timestamps from inputs and never consult a clock.

**The surgical version, if it is worth doing.** Pull the command-delivery effect out of `gateway.ts` into a
named layer-able function (`drainCommands` is already close); add `TestClock` to that focused unit suite only;
keep the seam-crossing assertions in `gateway.test.ts` on wall-clock. Do the same for the credential retry
schedule. Tempting but wrong: virtualizing `worker.ts`'s `Schedule.spaced(workerPollInterval)` — the harness
already bypasses it via `harness.runJobs()`, so there is no wait to remove, and the only place the schedule
runs for real is the spawned-worker integration test.

So: do the surgical version now, wait until the gateway suite becomes a maintenance burden, or decide the
wall-clock waits are permanently acceptable and stop revisiting it?
