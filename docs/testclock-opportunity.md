# TestClock opportunity: virtualize the scheduled Effect loops

This note records an option, not a decision. The component suites today use real
wall-clock waits for what are really Effect `Schedule` loops. Effect's `TestClock`
(`@effect/platform`'s `TestClock` / `effect`'s `Test.TestClock`) is the first-party tool
for removing those waits — but adopting it wholesale does not pay off here. This file
exists so a future maintainer can find the analysis when they're ready to consider it.

## The two cases where it would actually help

### 1. Command delivery poll loop

`apps/bebop/src/swordfish-gateway/gateway.ts` forks a scoped loop:

```ts
yield *
  Effect.forkScoped(
    Effect.gen(function* () {
      const current = session;
      if (current !== null) {
        yield* drainCommands(current);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("swordfish command poll failed", cause)),
      Effect.repeat(Schedule.spaced(config.commandPollInterval)),
    ),
  );
```

`commandPollInterval` defaults to 2s (`apps/bebop/src/config.ts`); the test harness
sets it to 150ms (`test/component/support/harness.ts`, `testConfig`).
`apps/bebop/test/component/gateway.test.ts` then ends several assertions with a real
wall-clock wait for the poll to fire:

- `await new Promise((resolve) => setTimeout(resolve, 300));` (line 204, dedup-ack)
- same pattern at lines 395, 413, 515, 581.

The peer in those tests is a real WebSocket over a real port — but the _effect side_
of that loop is a single in-process fiber running `Schedule.spaced`. That fiber is
exactly what `TestClock` virtualizes: provide `TestClock` in the gateway's layer,
advance the clock past one `commandPollInterval`, and the loop fires deterministically
with no wall-clock wait.

### 2. Bearer credential retry schedule

`apps/bebop/src/api/authentication.ts:33-35`:

```ts
const verifyCredentialSchedule = Schedule.exponential(Duration.millis(5), 2).pipe(
  Schedule.upTo({ duration: Duration.millis(60) }),
);
```

This schedule is exercised by `apps/bebop/test/component/api.test.ts` only indirectly,
through the real HTTP server against the real disposable Postgres. There is no unit
test of the schedule itself today. A standalone unit test that wrapped
`BearerAuthenticationLayer` against an in-memory token store returning a transient
`SqlError`, with `TestClock.adjust` driving the backoff, would catch a regression in
the retry/bounded-failure policy without standing up the whole stack.

## Why the _wholesale_ refactor is not worth it

Read `apps/bebop/test/component/support/harness.ts` first; the reasoning below assumes
it. The short version: the harness is deliberately the _production_ layer stack with two
substitutions (`fixedIdentityLayer`, `fakeLifecycleProviderLayer`). `TestClock` would be
a third substitution, and almost everything it virtualizes is already virtualized — or
already real, in ways `TestClock` cannot reach.

1. **`Identity` is not the clock.** It bundles seven generators (`bountyId`,
   `commandId`, ..., `now` — see `apps/bebop/src/domain/identity.ts`). `TestClock` only
   virtualizes `now`. The other six still need `fixedIdentityLayer`. Adoption adds a
   layer alongside, not a replacement.
2. **`fixedIdentityLayer.now` is an authoring counter, not a current-time read.** It
   advances the clock by a fixed `stepMillis` on _every read_
   (`identity.ts:122-126`). `TestClock.now` returns the current instant and only moves
   when something calls `TestClock.adjust`. To preserve current test semantics under
   `TestClock` you'd have to insert `TestClock.adjust(step)` at every site that reads
   `now` — strictly more glue, not less.
3. **The harness deliberately crosses process and socket boundaries.** A real
   `BunHttpServer` on an OS-assigned port, a real Postgres, a real WebSocket gateway with
   a real `Peer`. `TestClock` virtualizes in-process Effect fibers only; everything past
   the boundary (OS keep-alive expiry, the WS close handshake, PG connection lifecycle,
   _and the peer's view of heartbeats_) keeps moving on wall-clock. A partly-virtualized
   system is the worst sort: the Effect side fires "instantly" but the external observer
   still needs real `setTimeout` waits. The 300ms waits in `gateway.test.ts` would either
   stay or shrink slightly; they would not disappear.
4. **Most sleeps are not the scheduler's fault.** `gateway.test.ts:78, 570` are 10ms
   settle waits for the WS adapter to dispatch frames (`gateway.test.ts:570` is paired
   with `setTimeout(10)`). `cli.test.ts:127` (2.7s) waits for the SSE client to
   reconnect past the server's idle timeout — also a boundary behaviour, not an Effect
   schedule. `events.test.ts:67, 89` wait for the SSE poll to catch up.
   `lifecycle.test.ts:32` is a test-level deadline. `TestClock` reaches none of these.
5. **`Effect.sleep`/`Schedule` runs in spawned-child integration tests too.**
   `test/integration/entrypoints.test.ts` starts `bun apps/bebop/src/*.ts` subprocesses;
   the worker's `Schedule.spaced(workerPollInterval)` (`apps/bebop/src/worker.ts:48`)
   lives there. There is no `TestClock` story across a process boundary, so the suites
   that assert on the _real_ scheduler behaviours (packed-API-and-worker-share-state-and-
   survive-restart, retry-after-job-lease-expiry, idle-timeout reconnect) stay as written
   regardless.
6. **Domain and persistence suites gain nothing.** `apps/bebop/test/domain/*`,
   `apps/bebop/test/persistence/*`, and all of `packages/contracts/src/*.test.ts` take explicit
   timestamps from test inputs and never consult the clock.

## What "ready" would look like

If/when the gateway suite becomes a maintenance burden because of the magic-letter wall
waits, do the surgical version:

- Pull the command-delivery effect out of `gateway.ts` into a named, layer-able
  function that's callable without the surrounding connection (`drainCommands` is
  already close).
- Add a `TestClock` to the gateway's layer _only_ in a focused unit suite for that
  effect — keep the boundary-bearing integration assertions in `gateway.test.ts` on
  real wall-clock.
- Tempting but wrong: also try to virtualize `worker.ts`'s
  `Schedule.spaced(workerPollInterval)`. The harness already bypasses it via
  `harness.runJobs()` (`harness.ts:196-202`), so there's no wait to remove. The schedule
  is only exercised by the spawned-worker integration test, which can't use `TestClock`.

The same shape applies to the credential retry schedule: extract or wrap it in a unit
test with `TestClock.adjust(Duration.millis(...))` driving the exponential; do not try to
thread `TestClock` through `BearerAuthenticationLayer` into the integration suite.

## Pointer to the upstream primitive

`TestClock` is documented at <https://effect.website/docs/guides/effect/test-clocks/>
and is exported from `effect`. The repo does not currently import it anywhere — grep
`TestClock`/`Test.testClock`/`TestClock.layer` to confirm. The reason it isn't used is the
analysis above, not unfamiliarity with it.
