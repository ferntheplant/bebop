# Testing

Where each kind of test goes and why. The decisions behind this layout are recorded separately:
[one runner, launched by Bun](./adr/0020-vitest-is-launched-by-bun.md) and
[layered by what they bring up](./adr/0021-tests-are-layered-by-what-they-bring-up.md).

This repo runs **one test runner** — `vitest` launched by Bun, via `vp run test` (see `vite.config.ts` root
tasks). Tests are layered by _what they bring up_, not by file location, and each layer has a deliberate
colocation convention:

| Layer        | Location                                                 | What's stubbed                                  |
| ------------ | -------------------------------------------------------- | ----------------------------------------------- |
| Unit         | `src/<area>/<area>.test.ts` (co-located)                 | Nothing — pure functions / schemas / reducers   |
| Component    | `apps/<app>/test/component/`                             | `Identity` + `LifecycleProvider` only           |
| Integration  | `test/integration/`                                      | Nothing — real spawned `bun` child processes    |
| Local system | `test/local-system/`                                     | Nothing — packed processes over loopback        |
| Smoke        | `apps/<app>/scripts/smoke.ts` (via `vp run <app>#smoke`) | Nothing — runs the packed `dist/*.mjs` artifact |
| Prototypes   | `prototypes/*/run.ts`                                    | Throwaway — excluded from `vp run test`         |
| E2E          | `test/e2e/` (placeholder)                                | —                                               |

## Why unit tests are colocated

A unit test targets a single source file (a reducer, schema, row-decoder, config loader). Colocating `foo.ts`
and `foo.test.ts` keeps the test next to the code it constrains and makes deletions and renames commute
naturally. The vite-plus guide explicitly recommends `include: ['src/**/*.test.ts']`, and `vp pack` traces only
from explicit `pack.entry` inputs (`src/index.ts`, `src/api.ts`, ...), so colocated test files **do not** ship in
the bundled artifact. The `eslint/no-restricted-imports` rule permits sibling-relative imports, and tests already
import source via the package's `#src/*` subpath map, so colocation keeps moves mechanical.

Today, unit tests are colocated in:

- `packages/contracts/src/*.test.ts` — schema encode/decode round-trips and golden fixtures (`src/golden/`).
- `packages/workflow/src/core.test.ts` — shared pure workflow transition core.
- `apps/bebop/src/{domain,persistence}/*.test.ts` — reducers, snapshot round-trips, row-decoding, token hashing.
- `apps/swordfish/src/{config,workflow}/*.test.ts` — config decoding and the daemon-side reducer (with `golden-replay-v1.json`).

## Why component tests are _not_ colocated

`apps/bebop/test/component/*.test.ts` boot the **real production layer stack** in-process (`BunHttpServer`,
migrations, repositories, WebSocket gateway, real disposable Postgres) via `test/component/support/harness.ts:99`.
They stub exactly two layers — `fixedIdentityLayer` (deterministic IDs/time) and `fakeLifecycleProviderLayer` (no
real VM provisioning). They verify that bebop's _internal_ layers compose correctly, which is why they don't have
a single source file to colocate against. The shared `support/harness.ts` is itself the thing under test.

The `support/` directory imports through the `#test/*` subpath map declared in `apps/bebop/package.json`, which is
the structural signal that this code belongs to the composition layer and is shared across multiple suites that
have no individual source home.

## What distinguishes "component" from "integration"

The line is the **process seam**, not the size of the stack:

- **Component** builds the server in-process and reads the OS-assigned port directly
  (`support/harness.ts:136-161`). HTTP/WebSocket to a peer in the same test process is in-process; the only
  cross-fiber machinery is Effect schedulers.
- **Integration** (`test/integration/entrypoints.test.ts`) spawns `bun apps/bebop/src/*.ts` and `dist/*.mjs` as
  real child processes and asserts on exit codes, stdout, restart survival, bootstrap-token semantics. No
  `TestClock` story exists across a process seam, so these suites stay on real wall-clock.

## What distinguishes "smoke" from "integration"

Smoke is _post-packaging_: it spawns the real `dist/*.mjs` produced by `vp pack` and asserts it loads / reaches
its own code (`apps/bebop/scripts/smoke.ts:29-86`). It exists because missing dependencies, dead dynamic imports,
and platform modules that only resolve from source all fail here but **none show up in `vp check`** — typecheck
passes. `smoke` is gated by `vp run ready` (`vite.config.ts:124-132`).

## Prototypes are not tests

`prototypes/*/run.ts` are throwaway probe drivers run on demand via `vp run @bebop/prototype-<name>#prototype`,
excluded from `vp run test`. Each validates a single design assumption (persistence durability, Effect-on-Bun
HTTP/SSE/WS, lease guard, tmux lock, packed-process protocol composition). Their recorded findings —
bigint-as-string, `jsonb` reorder, security middleware, `BunStdio`, bounded shutdown, retry-stable replay, and
stop delivery — get re-pinned as named assertions in downstream unit, component, or integration tests, and the
ones that shaped the design are written up in [`docs/adr/`](./adr/).

The [real-process loopback prototype](../prototypes/real-process-local-protocol/README.md) was the process-level
exception that proved two applications compose rather than proving one entrypoint starts. It launched only packed
artifacts and drove public HTTP, WebSocket, CLI, and Unix-socket interfaces; it did not import app source or write
either database. Its production follow-up is the local system harness,
maintained under `test/local-system/` and run via `vp run local-system`: the same packed peers over disposable
Postgres, where creating a bounty is what makes a Swordfish daemon exist because the lifecycle provider starts it
([A local Swordfish outlives the worker that started it (ADR 0048)](./adr/0048-a-local-swordfish-outlives-the-worker-that-started-it.md)).
The harness starts no daemon of its own and could not: the machine credential never reaches disk, so it restarts
one by requeuing provisioning through the API. It clones from a bare repository it creates on disk, which keeps
the clone real while leaving the suite offline and repeatable.

## Database gating: `BEBOP_TEST_DATABASE_URL`

Every Postgres-backed suite opens with:

```ts
const suite = testDatabaseAvailable ? describe : describe.skip;
```

`testDatabaseAvailable` is `adminDatabaseUrl() !== null` from `@bebop/testkit`
(`packages/testkit/src/postgres.ts:36`). When `BEBOP_TEST_DATABASE_URL` is unset, the suite skips and the gate
stays green — `README.md` documents the trade: `vp run ready` passes on a machine with no Docker, CI always
provides the service, and `vite.config.ts:112` puts the env var in the cache key so a run with a database and a
run without are not the same run.

## The single substitution seam

This repo does **not** use Effect's `TestClock`, `TestServices`, or `TestContext` anywhere. Instead,
side-effecting things are wrapped in Effect services and replaced at the layer seam:

- `Identity` (`apps/bebop/src/domain/identity.ts:28`) bundles ID generation **and** `now`, replaced by
  `fixedIdentityLayer` in the component harness. `TestClock` would virtualize only `now`, not the other six
  generators, so it is additive not substitutive. Whether to adopt it for the scheduled loops is an open
  question.
- `LifecycleProvider` (`apps/bebop/src/lifecycle/provider.ts`) is replaced by `fakeLifecycleProviderLayer` with
  hookable `onProvision` / `onProvisionAttempt` / `failProvisionAttempts` callbacks.
- Time and external clients stay on real wall-clock. The integration suites need this because they assert on
  actual scheduler / idle-timeout behaviour in spawned children.

## Fixtures

Fixtures live under `packages/testkit/fixtures` and are versioned like production inputs. Fixture setup must not
depend on the developer's global Git identity, shell configuration, tmux configuration, OpenCode configuration,
or occupied ports — a test that passes only on the machine that wrote it is worse than no test.

The set the MVP needs:

- a minimal valid `.bebop/` repository, and one exhibiting every hook failure mode;
- a repository with a simple browser QA service;
- fake OpenAI-compatible streaming server scripts;
- valid and invalid Bebop–Swordfish protocol transcripts;
- prior SQLite and Postgres schema versions, for migration tests;
- evidence blobs with duplicate content, hash mismatches, and interrupted uploads;
- a GitHub smoke repository outside this one.

## How process-level suites wait

A suite that spawns real processes has to decide when the thing it started is ready. Two tempting answers are
both wrong, and both have already cost a day of CI archaeology:

- **A file appeared.** The Swordfish control socket is bound before migrations and bootstrap run, so it accepts
  connections for the whole of startup and parks them — see [gotchas](./gotchas.md#process-lifecycle).
- **A freshly spawned CLI finished inside a short timeout.** Cold-starting `bun` and loading a packed entrypoint
  costs ~130ms idle, ~600ms at 4× CPU oversubscription and ~1.4s at 8×. `vp run ready` fans five tasks out at
  once, so CI reaches those levels routinely. A readiness poll that spawns a process on a one-second budget
  stops measuring the daemon and starts measuring the scheduler, and past that cliff it can never succeed no
  matter how healthy the daemon is: every probe is killed before it connects. Worse, a killed Effect CLI exits
  130 having printed nothing, so the failure reports an empty error and blames the process it was watching.

Readiness is therefore **the daemon answered a request**. `waitForSwordfishControl` in `@bebop/testkit` is that
wait for Swordfish: it probes over the socket in-process, so it costs what it measures, cannot be killed
mid-flight, and reports per-attempt detail when it gives up. `waitForResponse` in `test/integration` is the HTTP
equivalent.

This does not mean process-level suites stop driving the real CLI — driving it is what they are for. It means
the CLI is the **subject** of an assertion, never the **stopwatch** for a readiness decision. Wait in-process,
then invoke the packed binary once, on a generous timeout, and assert on what it said.

The same reasoning applies to any budget that silently includes a process spawn. A test asserting "this
finished within 2 seconds" where the two seconds contain a cold start is asserting something about the runner.
Assert the property instead — that the process exited on its own rather than having to be killed.

## A test's budget must exceed the longest wait it can perform

Otherwise the wait can never fire, and the specific diagnostic it would have produced is unreachable. A suite
whose SSE reader allows 10s while the test runs on a 5s budget does not report `Expected 206 SSE frames,
received 3`; it reports `Test timed out in 5000ms` and points at whichever line was last awaited. That is how a
page-boundary streaming bug and a merely slow runner become the same message.

`testTimeout` and `hookTimeout` are therefore set to 30s in the root `vite.config.ts` — above every wait the
suites declare, with room for the oversubscription `vp run ready` creates. A passing test never spends that
budget; only a test that was going to fail waits longer to say what went wrong.

A test needing longer than 30s says so on the test, and several do. When you add one, the invariant to keep is
the ordering: **internal wait < test budget**. If you find yourself raising an internal timeout, check what
budget it now has to fit inside.

## Where to put the next test

- A pure function or schema round-trip next to a single source file? → colocate at `src/<area>.test.ts`.
- An assertion that bebop's compose-with-real-Postgres wiring holds? → `apps/bebop/test/component/`.
- An assertion about _process_ behaviour (entrypoint exit codes, restart survival, packed-bundle boot)? → `test/integration/`.
- A test that the packed artifact loads without a missing dependency? → `apps/<app>/scripts/smoke.ts` and its `vp run <app>#smoke` task.
- Validating a single design assumption you might not keep? → `prototypes/<name>/run.ts`.
