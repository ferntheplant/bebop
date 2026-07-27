# PLAN: Bebop MVP Implementation

**Status:** Draft 0.1

**Date:** 2026-07-26

**Source of truth:** [`SPEC.md`](./SPEC.md)

## 1. Purpose

This document turns the Bebop system design into an implementation sequence. The plan favors vertical slices that can be demonstrated and tested locally before adding exe.dev, GitHub, model credentials, or other external authority.

The first useful milestone is not a fully provisioned bounty. It is a local Bebop server and a local Swordfish daemon that share the real contracts, persist their state, reconnect safely, and can drive a small deterministic workflow. External integrations are added only after that control plane works under failure.

## Session Progress

Progress through 2026-07-26:

- **Milestone 0 is complete and validated:** every build-critical spike now has a runnable fixture and a recorded verdict, and all four pass (41 probes total). Bun/Vite+ workspace operation and Effect Schema on Bun are proven. The plugin lease guard, the pinned OpenCode fake-model turn, and the OpenCode version pin are proven together by `spikes/lease-guard/` against OpenCode 1.18.5; two gaps were found and both close with verified OpenCode configuration rather than new architecture, raising `SPEC.md` §11.5 from two enforcement layers to four and binding the seat credential's lifetime to the control lease. `spikes/persistence/` proves the Postgres and SQLite round trip, `spikes/tmux-input-lock/` proves the cockpit input lock, and `spikes/effect-runtime/` proves Effect's HTTP, SSE, WebSocket, and CLI modules run as processes on the pinned Bun. Four findings change work in later milestones; they are listed under Milestone 0 below.
- **The Milestone 1–2 review in [`REVIEW.md`](./REVIEW.md) is partly actioned.** The two findings flagged as blocking Milestone 3 are resolved, along with everything else at the reducer boundary: H1 (`packages/workflow` now holds the single transition core), M2 (freshness recovers on traffic), M3 (`applied: false` carries a reason so the gateway knows whether to acknowledge), M4 (`cancelling` protected), M6 (bounded, hashed fingerprints with an explicit floor), L5, and L8. A second drift was found during the extraction and fixed: Bebop's projection did not clear `attentionReason` on resume. Every low-level finding is also closed: L1 (branded list cursors), L2 (the golden encoding fixture is renamed so it cannot be mistaken for a replayable transcript), L3 (`Schema.toEquivalence` instead of a key-order-dependent comparison), L4, L6 (`DevelopmentServerUrl`), and L7 (the acceptance-criteria constraint is recorded in `SPEC.md` §7.5). M5 is closed by `packages/contracts/src/commands.ts`, which holds the payloads both protocols share and states the rule that changing one bumps both versions; `commands.test.ts` is the tripwire that enforces it, since neither protocol's golden fixtures can. `REVIEW.md` carries the per-finding resolution notes and a status table. Still open, and each needs a design decision rather than an edit: H2 (no schema for validator results, findings, or feedback packets — and whether those ride the protocol or the evidence bundle), H3 (`bebop token` has no routes, and `SPEC.md` §17.2 must be corrected before schemas can be added), M1 (token rotation has no wire representation: add `token`/`rotatedToken` to registration, or strike rotation from `SPEC.md` §18.2), and M7 (where the unauthenticated liveness route lives, given §24's health-checked blue/green containers).
- **Milestone 1 is complete and validated:** the monorepo, three apps, shared contracts and testkit packages, strict per-workspace TypeScript environments, conventional-commit hooks, CI, builds, process-level entrypoint tests, artifact smokes, and workspace documentation are in place. Frozen install and `vp run ready` pass.
- **Correction (2026-07-26):** Milestone 1's exit criterion "a clean clone can run `vp install --frozen-lockfile` and `vp run ready`" was **not** actually met when it was marked complete. `ready` passed only on a machine that already had `dist` from an earlier build, and CI had been failing on `main` since `6cba85f` for this reason. Two ordering faults: Vite+ resolves a bare `./dist/*.mjs` command as a binary at plan time, before `build` runs; and `vp check` type-checks apps against `@bebop/contracts`, which resolves through its built `dist`. Fixed by invoking executable artifacts as `sh -c './dist/cli.mjs'`, and by replacing the shell `&&` chains with Vite+ `dependsOn` task dependencies so each task builds its own prerequisites. Verified by a fresh clone plus frozen install.
- **Milestone 2 is complete and validated:** shared wire and domain schemas, bidirectional Bebop-Swordfish and local `sf` protocols, typed process configuration, authenticated Bebop HTTP/SSE contracts with generated OpenAPI, pure workflow/projection reducers, and golden replay/idempotency coverage are implemented. Frozen install and `vp run ready` pass.

## 2. Repository Decisions

The repository uses:

- Bun as the runtime and package manager;
- Vite+ for monorepo task orchestration and developer tooling;
- Oxlint and Oxfmt through Vite+;
- commitlint with the conventional-commits configuration;
- Effect and Effect Schema for services, errors, configuration, and contracts;
- Vitest through Vite+ for unit, integration, and process-level tests;
- Docker Compose only for stateful local dependencies such as Postgres;
- conventional commits on every branch.

### 2.1 Initial layout

```text
apps/
  bebop/
    src/
      api/
      cli/
      domain/
      persistence/
      swordfish-gateway/
      worker/
    test/
  swordfish/
    src/
      cli/
      daemon/
      opencode/
      persistence/
      repository/
      workflow/
    test/
  bebop-opencode-plugin/
    src/
    test/
packages/
  contracts/
    src/
    test/
  workflow/
    src/
    test/
  testkit/
    src/
    fixtures/
SPEC.md
PLAN.md
package.json
tsconfig.json
vite.config.ts
bun.lock
```

`apps/bebop` owns separate server, worker, and thin CLI entry points while remaining one workspace. `apps/swordfish` owns the long-running daemon and the local `sf` CLI. This preserves the requested three-app layout without putting deployable programs in shared packages.

`packages/contracts` is the only required production package at initialization. It contains Effect Schemas and transport-neutral domain values shared by two or more apps.

`packages/workflow` was added after Milestone 2, when a second app needed it. It holds the pure Swordfish workflow transition core — the interpretation of the event stream that Swordfish and Bebop's projection must agree on. It has no I/O and no persistence. Bebop's projection is that core plus connection identity and freshness, which is Bebop's own concern; Swordfish's reducer is that core plus a non-null starting stage.

`packages/testkit` is development-only. It contains process harnesses, protocol peers, temporary Git repositories, fixture hooks, fake model endpoints, clocks, and eventually a fake exe.dev adapter.

Do not create a generic `utils` package during initialization. Code stays with its first consumer and moves into a narrowly named package only after a second app needs it. Apps must not import source code directly from other apps.

`packages/workflow` is what that rule looks like when it fires: sharing the wire types was not enough, because two apps had independently written down what those types _mean_ and the two copies had already drifted.

### 2.2 Entrypoints

| Workspace                    | Entrypoint | Output                             |
| ---------------------------- | ---------- | ---------------------------------- |
| `apps/bebop`                 | API        | `bebop-api` container process      |
| `apps/bebop`                 | Worker     | `bebop-worker` container process   |
| `apps/bebop`                 | CLI        | `bebop` executable                 |
| `apps/swordfish`             | Daemon     | `swordfish` service executable     |
| `apps/swordfish`             | CLI        | `sf` executable                    |
| `apps/bebop-opencode-plugin` | Plugin     | installable OpenCode plugin bundle |

The `bebop` CLI calls only the public Bebop HTTP API. The `sf` CLI calls only Swordfish's local control socket. Neither CLI reads Postgres or SQLite directly.

## 3. Tooling Baseline

### 3.1 Bun workspace

Create a private root package with `workspaces` covering `apps/*` and `packages/*`. Pin the Bun version in `packageManager` and CI. Commit `bun.lock` and require frozen installs in CI.

Use a root dependency catalog if the selected Bun version supports every Vite+ dependency form needed by the workspace. Validate this before generating child packages rather than copying Blueberry's pnpm-specific workspace file.

### 3.2 Vite+, Oxlint, and Oxfmt

Adapt `../blueberry/vite.config.ts` as the initial root configuration:

- staged files run `vp check --fix`;
- formatting uses spaces, width 2, semicolons, double quotes, trailing commas, a 120-character print width, sorted imports, and sorted package manifests;
- generated TypeScript, `dist`, `build`, `.tanstack`, and `.wrangler` paths are ignored;
- linting enables the TypeScript, Unicorn, Oxc, and Vite+ plugins;
- type-aware linting and type checking are enabled;
- warnings are errors;
- Blueberry's lint rules are copied, including no explicit `any`, no floating promises, consistent type imports, no non-null assertions, and restricted parent imports;
- tests may initially pass with no tests only during repository initialization.

Add project-specific ignores only for generated OpenAPI artifacts, test fixture output, temporary SQLite files, and coverage output. Do not weaken rules globally to accommodate one package.

### 3.3 TypeScript

Start from Blueberry's strict `tsconfig.json` and add only Bun types and project references required by Vite+. Keep `noUncheckedIndexedAccess`, `noUnusedParameters`, `noUncheckedSideEffectImports`, and `noEmit` enabled.

Each workspace extends the root configuration and declares its own environment. Server packages must not acquire DOM globals accidentally; the plugin package may use only the OpenCode runtime APIs it needs.

### 3.4 Commit policy

Install `@commitlint/cli` and `@commitlint/config-conventional`. Add:

- `commitlint.config.ts` extending the conventional configuration;
- `.vite-hooks/pre-commit` running `vp staged`, matching Blueberry;
- `.vite-hooks/commit-msg` running the locally installed commitlint against the supplied message file;
- a pull-request CI check that validates the commit range, so local hook bypasses do not weaken repository policy.

Scopes such as `bebop`, `swordfish`, `plugin`, and `contracts` are recommended but not initially mandatory. Release automation can consume conventional commits later without being part of repository initialization.

### 3.5 Root commands

The root package exposes a small command surface:

```text
vp run dev
vp run build
vp run check
vp run test
vp run test:integration
vp run test:e2e
vp run smoke
vp run ready
```

`ready` runs formatting verification, linting, type checking, unit tests, integration tests that do not require external credentials, and artifact smokes. Credentialed exe.dev and GitHub smoke tests remain separate commands.

These are Vite+ tasks declared in `vite.config.ts`, not shell chains. Each declares its prerequisites with `dependsOn`, so any of them can be run alone on a clean checkout and will build what it needs first. `ready` is an aggregator: its gate is its dependency set.

## 4. Architectural Rules

- `packages/contracts` defines schemas; transport implementations consume them.
- Every network and local-socket payload is decoded at its boundary.
- Domain failures are typed values; defects remain crashes handled by process supervision.
- State transitions are pure and tested separately from persistence and I/O.
- Postgres is authoritative for Bebop state; SQLite is authoritative for Swordfish state.
- Bebop and Swordfish write durable intent before performing externally visible side effects.
- At-least-once messages carry stable IDs or sequence numbers and are safe to replay.
- Time, IDs, process execution, and external clients are Effect services so tests can replace them.
- OpenCode is integrated directly. Do not create a generic agent-harness abstraction.
- exe.dev and GitHub sit behind app-local services for testing, not shared multi-provider abstractions.
- Logs are structured and include `bounty_id`, `vm_id`, `seat`, `stage`, `candidate_sha`, and correlation IDs when available.

## 5. Testing Layers

| Layer          | Purpose                                                         | External processes                  |
| -------------- | --------------------------------------------------------------- | ----------------------------------- |
| Unit           | Reducers, schemas, policy, retries, command parsing             | None                                |
| Component      | Persistence repositories, API handlers, blob store, hook runner | Postgres or child process as needed |
| Contract       | Bebop-Swordfish envelopes and OpenCode API/event assumptions    | Fake peer or pinned OpenCode        |
| Integration    | Swordfish with Git worktrees, hooks, OpenCode, tmux             | Real local binaries                 |
| End-to-end     | Bebop and Swordfish as separate processes over real transports  | Postgres plus both apps             |
| Provider smoke | exe.dev, GitHub App, HTTP Proxy, private previews               | Credentialed external services      |

Tests must not call a paid model by default. OpenCode integration tests use a local fake model endpoint with scripted streaming and tool-call responses. Provider smoke tests are explicit and separately gated.

## 6. Implementation Milestones

Each milestone ends with a runnable demonstration and an automated exit check. A later milestone must not compensate for missing correctness in an earlier boundary.

### Milestone 0: Resolve Build-Critical Spikes

**Status:** Complete and validated (2026-07-26)

Every spike is a runnable fixture under `spikes/`, invoked as `vp run @bebop/spike-<name>#spike`. Each exits
nonzero if any probe fails, tears its own state down before it starts so an interrupted run cannot make a later
run lie, and records a verdict in its `README.md`.

**Work**

- ~~Verify the pinned Bun version can install and run Vite+ in a Bun workspace.~~ **Done:** proven by the repository itself.
- ~~Verify Vite+ invokes type-aware Oxlint, Oxfmt, and Vitest correctly under Bun.~~ **Done:** proven by `vp run ready`.
- ~~Verify Effect HTTP, Postgres, SQLite, WebSocket, and CLI packages work on the selected Bun version.~~ **Done:** `spikes/persistence/` (16 probes) covers Postgres and SQLite; `spikes/effect-runtime/` (14 probes) covers HTTP, SSE, WebSocket, and CLI. Both confirm the assumption.
- ~~Pin an OpenCode version and capture its OpenAPI document and event names.~~ **Done:** 1.18.5, pinned in the root catalog.
- ~~Prove the OpenCode plugin API can reject prompt submission for a leased seat.~~ **Done with a gap:** confirmed for `message`, `prompt_async`, and `command`; `POST /session/:id/shell` bypasses every hook, so `SPEC.md` §11.5 now requires a Swordfish-owned transport layer. See `spikes/lease-guard/README.md`.
- ~~Prove OpenCode can use a local fake model endpoint for deterministic integration tests.~~ **Done:** `spikes/lease-guard/fake-model.ts` serves an OpenAI-compatible streaming endpoint and counts every request.
- ~~Prove tmux can disable input to one pane without hiding its output.~~ **Done:** `spikes/tmux-input-lock/` (11 probes) confirms it, including for a real attached client. See that spike's README.

**Exit criteria**

- ~~A throwaway workspace passes `vp check` and one Vitest test under Bun.~~ **Met.**
- ~~A small Effect process round-trips one row through Postgres and SQLite.~~ **Met** by `spikes/persistence/`.
- ~~A pinned OpenCode process starts, emits events, accepts a plugin, and completes one scripted fake-model turn.~~ **Met** by `spikes/lease-guard/`.
- ~~Any failed assumption is reflected in `SPEC.md` before implementation continues.~~ **Met.** The lease-guard gap raised `SPEC.md` §11.5 to four enforcement layers. The only other correction is factual: §25 named `@effect/sql-sqlite`, and the package that exists on the Effect 4 beta line is `@effect/sql-sqlite-bun`. Nothing else failed.

**Findings that change later milestones**

These are recorded here because they are cheap to honour now and expensive to discover mid-milestone. Each spike's
README carries the evidence.

- **Postgres `jsonb` does not preserve key order** (`spikes/persistence`, PG4b). The Milestone 2 decision that reducers "retain fingerprints for every applied sequence so conflicting replay fails closed" cannot be implemented by re-serialising a payload read back from `jsonb` — every replay would look like a conflict. Milestone 3 must compute each fingerprint once at the protocol boundary and store it in its own column.
- **Postgres `bigint` decodes as a JavaScript `string`** (`spikes/persistence`, PG5). Values are exact, but any Milestone 3 schema reading a sequence number, cursor, or acknowledgement offset must accept the string encoding rather than `Schema.Number`.
- **Effect 4 security middleware wraps the endpoint effect** (`spikes/effect-runtime`, finding 1). It receives the endpoint's own effect and must return it; a handler that returns `Effect.void` on success silently skips the route instead of failing. Bebop declares `BearerAuthentication` on the whole API, so Milestone 3 needs a test asserting an _authorised_ request reaches its handler, not only that an unauthorised one is refused.
- **`Migrator.fromFileSystem` will not survive `vp pack`** (`spikes/persistence`, finding 6). It loads migrations by dynamic import from a directory. The packaged single-binary Swordfish in `SPEC.md` §25 needs `Migrator.fromGlob`, whose imports are statically analysable; `fromFileSystem` stays fine for tests.
- **`Command.run` reads argv from the `Stdio` service** (`spikes/effect-runtime`, finding 4), which `BunRuntime.runMain` does not provide. Both CLIs must supply `BunStdio.layer` or every invocation fails at startup, including `--help`.
- **The tmux input lock is clearable by any pane in the session** (`spikes/tmux-input-lock`, finding 4). Milestone 8 must not present it as protection, and its exit criterion should be asserted against the seat program's received input rather than a terminal snapshot.

### Milestone 1: Initialize the Monorepo

**Status:** Complete and validated (2026-07-26)

**Work**

- Initialize Git without changing `SPEC.md`; update `PLAN.md` only when implementation corrects a planning assumption.
- Create the root Bun workspace and lockfile.
- Add the Vite+ configuration adapted from Blueberry.
- Add strict root and workspace TypeScript configurations.
- Add commitlint and Vite+ Git hooks.
- Create the three app workspaces and two initial package workspaces.
- Add a minimal CI workflow for frozen install, `ready`, and commitlint.
- Add `.gitignore` entries for Bun, Vite+, coverage, SQLite, Postgres volumes, fixture worktrees, logs, and build output.
- Add workspace ownership documentation in a root `README.md`.

**Exit criteria**

- A clean clone can run `vp install --frozen-lockfile` and `vp run ready`.
- Each app has a minimal executable or loadable entrypoint.
- Invalid formatting, lint, types, tests, and commit messages each fail in the expected layer.

### Milestone 2: Define Contracts and State Machines

**Status:** Complete and validated (2026-07-26)

**Current checkpoint:** Exit criteria satisfied; Milestone 3 is next.

**Work**

- Encode IDs, timestamps, SHAs, sequence numbers, and protocol versions as schemas.
- Encode bounty states, detailed Swordfish stages, seat roles, leases, constraints, effective specs, candidates, findings, and evidence manifests.
- Define Bebop HTTP request, response, error, and SSE event schemas.
- Define Bebop-Swordfish registration, heartbeat, event, acknowledgement, and command envelopes.
- Define the local `sf` control request and response schemas.
- Define typed configuration schemas for both processes.
- Implement pure Bebop projection and Swordfish workflow reducers.
- Generate OpenAPI from the same HttpApi schemas used by the server.
- Add golden serialization tests and reject unknown protocol versions explicitly.

**Exit criteria**

- Every example in the relevant `SPEC.md` schemas has a passing decode test.
- Invalid IDs, stages, sequence numbers, and cross-version messages fail with stable typed errors.
- Reducer tests cover legal transitions, illegal transitions, candidate invalidation, and idempotent reapplication.
- No app-local duplicate of a shared wire type exists.

**Implementation decisions established during review**

- Protocol cursors may be zero, but produced events start at one. Reducers reject gaps, treat exact replay as a no-op, and retain fingerprints for every applied sequence so conflicting replay fails closed.
- `candidate_submitted` carries only a `candidate_ready` disposition. Gate outcomes are bound to both candidate SHA and spec revision; CI and review remain independent parallel gates; Swordfish readiness is a claim that Bebop must verify independently.
- Candidate invalidation clears every gate and readiness claim. Human control remains visible until explicit handback, while the suspended workflow stage survives invalidation, attention, repeated attention, and nested human-control transitions.
- Bebop connection freshness is scoped to a `connectionId`. Delayed events, heartbeats, disconnects, or stale timers from replaced or closed connections cannot mutate the active projection, and freshness changes never rewrite workflow authority.
- Local `sf handback` and `sf approve-config` requests are argument-free; the daemon derives and atomically rechecks the active seat or pending candidate. Responses must match both the request correlation ID and command.
- Evidence upload uses `bundleId` as the durable idempotency key: offer manifest, upload only missing content-addressed blobs through bounded HTTPS targets, then finalize. Manifest paths and download paths are canonical and must match exactly.
- Every HTTP endpoint, including health, declares bearer authentication. SSE replay has one cursor source (`Last-Event-ID`), and each canonical SSE ID must equal its typed event cursor.
- Process configuration rejects unsafe URL schemes, non-positive limits, non-canonical paths, overlapping Swordfish state/workspace paths, and invalid heartbeat or reconnect timing relationships. Secrets remain `Redacted` until their transport boundary.
- The pinned Effect 4 beta exposes HttpApi, OpenAPI, CLI, and related platform APIs under `effect/unstable/*`; adding current Effect 3 `@effect/platform` or `@effect/cli` packages would create an incompatible peer-dependency stack.

### Milestone 3: Implement a Local Bebop Server

**Work**

- Add Effect configuration, structured logging, startup health, and graceful shutdown.
- Add Postgres migrations and repositories for bounties, VM mappings, commands, Swordfish event projections, API tokens, approvals, and idempotency keys.
- Implement hashed named bearer tokens and request authentication.
- Implement bounty create, list, status, event-stream, stop, and destroy routes against a fake local lifecycle provider.
- Implement cursor-based SSE replay followed by live events without a history/live race.
- Implement the Swordfish connection gateway, registration validation, heartbeat freshness, event acknowledgement, and durable command queue.
- Run worker responsibilities as a separate entrypoint using the same image and repositories.
- Add the first thin `bebop` CLI commands for health, create, list, status, and events.

Do not integrate exe.dev or GitHub in this milestone. The fake lifecycle provider creates deterministic local VM records and lets the control-plane behavior stabilize first.

**Exit criteria**

- API component tests run against a real disposable Postgres database.
- Creating the same bounty request with one idempotency key cannot create duplicate lifecycle work.
- SSE replay delivers each stored event once in sequence before switching to live delivery.
- Restarting the API and worker preserves bounties, commands, tokens, and projections.
- The CLI has no behavior unavailable through the HTTP API.

### Milestone 4: Implement Swordfish Core and `sf`

**Work**

- Add SQLite migrations, WAL configuration, busy handling, and integrity checks.
- Persist workflow events, current stage, seats, leases, specs, candidates, constraints, validator outcomes, findings, local artifacts, and the Bebop outbox.
- Implement the pure workflow reducer as a durable event application loop.
- Implement outbound registration, reconnect, heartbeat, sequenced event delivery, acknowledgements, and command deduplication.
- Implement startup reconciliation without OpenCode initially: inspect SQLite, worktrees, child-process records, and outbox state.
- Add a permission-restricted Unix socket for local control.
- Implement `sf status`, `sf stop`, and diagnostic output first.
- Add `sf takeover`, `sf handback`, `sf extend`, `sf retry`, and `sf approve-config` as their workflow stages become available.
- Run Swordfish under an external process supervisor in development and image fixtures.

**Exit criteria**

- Killing Swordfish after committing an event but before acknowledgement causes a safe replay after restart.
- Repeating a Bebop command ID does not repeat its side effect.
- `sf` cannot operate when the daemon is absent, the socket permissions are unsafe, or the response fails schema validation.
- The daemon never exposes direct SQLite mutation through the CLI.

### Milestone 5: Bebop-Swordfish End-to-End Protocol

Run the real Bebop API, worker, Postgres, and Swordfish daemon as separate processes. Use random ports and temporary directories. Insert a controllable TCP proxy between the processes to simulate network failure without mocking either protocol implementation.

**Required scenarios**

- valid registration binds the expected bounty and VM identity;
- an invalid token, bounty ID, VM ID, or protocol version is rejected;
- heartbeats update freshness and a missed threshold marks the projection disconnected;
- ordered events update Bebop's projection and appear on the client SSE stream;
- duplicate events are acknowledged without duplicate projection changes;
- a disconnect before acknowledgement replays the event from Swordfish SQLite;
- a disconnect after acknowledgement does not lose or repeat visible state;
- Bebop queues a command while Swordfish is offline and delivers it after reconnect;
- duplicate commands do not repeat takeover, stop, or retry behavior;
- restarting Bebop preserves its acknowledgement cursor and pending commands;
- restarting Swordfish preserves its sequence and unsent outbox;
- temporary Bebop unavailability does not prevent a local Swordfish-only transition;
- bounded queues and oversized or malformed messages fail closed.

**Exit criteria**

- The full suite is deterministic and runs without external credentials.
- Repeated stress runs do not produce gaps, sequence regressions, duplicate commands, leaked child processes, or hanging ports.
- Logs from both processes share correlation and bounty identifiers for every scenario.

### Milestone 6: Repository Configuration, Worktrees, and Hooks

**Work**

- Parse and validate `.bebop/config.yml` from the correct base revision.
- Resolve mandatory setup and hook executables from the base revision.
- Detect changes to `.bebop/**` and configured privileged paths before execution.
- Create SHA-pinned clean worktrees with isolated artifact and result directories.
- Allocate deterministic environment variables and isolated ports.
- Execute hooks in their own process groups with captured stdout, stderr, exit status, timing, and resource metadata.
- Enforce timeouts and kill the complete process group.
- Parse optional JSON findings without making JSON presence the pass/fail authority.
- Collect artifacts without following paths outside the artifact directory.
- Tear down worktrees and child processes after evidence is staged.
- Normalize hook results into feedback packets and workflow events.

**Hook failure policy**

| Failure                                                               | Swordfish behavior                                                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Provision-time `setup/primary` exits nonzero or times out             | Persist setup evidence and enter `NEEDS_ATTENTION`; there is no candidate revision loop yet                                  |
| Candidate-bound setup, validation, QA, or evidence hook exits nonzero | Persist a stage-specific blocking result, enter `REVISION`, send captured feedback to ein, and do not start downstream gates |
| Candidate-bound hook times out                                        | Kill its process group, persist timeout evidence, enter `REVISION`, and consume that stage's configured attempt budget       |
| Hook is missing or cannot start                                       | Enter `NEEDS_ATTENTION` as a repository or supervisor contract failure                                                       |
| Base configuration is invalid                                         | Enter `NEEDS_ATTENTION`; candidate code cannot approve or repair the governing configuration                                 |
| Optional result JSON is absent                                        | Honor the exit code and continue with unstructured logs                                                                      |
| Optional result JSON is malformed                                     | Honor the exit code, preserve the parse warning and raw file as evidence, and do not invent findings                         |
| Artifact escapes its allowed directory                                | Reject the artifact, record a security finding, and enter `NEEDS_ATTENTION`                                                  |
| Candidate changes a privileged path                                   | Stop before hooks and wait for SHA-pinned approval                                                                           |
| Swordfish crashes during a hook                                       | Reconcile the process and worktree on restart; never silently rerun an operation of unknown status                           |

**Integration fixtures**

- passing validator with structured findings and artifacts;
- failing validator with stdout, stderr, and nonzero exit;
- timeout that leaves a grandchild process running unless the process group is killed;
- malformed optional result JSON;
- symlink and path-traversal artifact attempts;
- candidate with uncommitted files omitted from its submitted SHA;
- candidate changing `.bebop/**`;
- approved privileged change tied to one SHA and invalidated by a later change;
- clean worktree proving it cannot see ein's uncommitted files;
- a second candidate invalidating all first-candidate hook results.

**Exit criteria**

- A failing hook always produces durable, commit-bound feedback and blocks downstream stages.
- A passing hook is authoritative only for the exact candidate SHA and spec revision.
- No hook can read Bebop credentials or publish evidence externally.
- Repeated runs leave no worktrees, ports, or child processes behind.

### Milestone 7: OpenCode and Plugin Integration

Build the OpenCode client and Bebop plugin together against the pinned version proven in Milestone 0.

**Swordfish work**

- Start or connect to the OpenCode server and verify its version and health.
- Create, discover, and persist role-to-session seat mappings.
- Send asynchronous prompts through the server API rather than terminal input.
- Subscribe to SSE before depending on prompt completion events.
- Handle idle, error, status, message, permission, and abort events.
- Persist enough event/message identity to reconcile after restart.
- Implement one idle-recovery prompt and then `NEEDS_ATTENTION`.
- Implement safe abort as abort request, observed boundary, and recorded last message ID.
- Apply fixed permission profiles for ein, jet, and faye.

**Plugin work**

- Implement `/auto` and the effective-spec confirmation flow, including seat-credential revocation inside the atomic `set_spec` transition.
- Implement `set_spec`, `candidate_ready`, `blocked`, `continue`, and role-aware handback tools.
- Inject role, stage, spec, candidate, and constraint context into prompts.
- Correlate the OpenCode session ID to the Swordfish seat.
- Enforce the control lease before prompt submission, regardless of client, via `chat.message` and `command.execute.before`.
- Spawn each seat's OpenCode server with a random per-boot `OPENCODE_SERVER_PASSWORD` and a private `OPENCODE_DB`, closing the unhooked `POST /session/:id/shell` route and second-instance access that no plugin hook observes.
- Treat the seat password as the seat's write capability: never publish it, issue it only through `sf takeover`, and rotate it on every control release when one was issued.
- Rotate by restarting the seat server, re-attaching seat panes and the event subscription, and reconciling the restart like any other externally visible operation.
- Record any seat activity Swordfish did not originate as an intrusion and escalate to `needs_attention`.
- Deny and report unexpected permission requests while Swordfish owns the lease.

**Integration strategy**

- Run a real pinned OpenCode server in tests.
- Point OpenCode at a local scripted OpenAI-compatible model endpoint.
- Script normal streaming, tool calls, abrupt stream closure, delayed completion, and malformed provider responses.
- Use the real plugin bundle, not a test replacement.
- Assert through OpenCode's API and Swordfish's durable state, not terminal snapshots.

**Required scenarios**

- interactive ein session becomes autonomous only after confirmed `set_spec`;
- idle without `set_spec` remains interactive after one recovery failure;
- `candidate_ready` records the exact SHA and current spec revision;
- idle without a disposition is re-prompted once, then needs attention;
- a human prompt to a Swordfish-leased seat is rejected by the plugin, asserted by the fake model endpoint receiving zero requests rather than by the rejection status alone;
- a leased seat cannot be driven through `POST /session/:id/shell`, which bypasses every plugin hook and is closed by the server password;
- a second OpenCode instance started in the seat's directory with `--pure` cannot see or reach the seat's session;
- seat activity that Swordfish did not originate is recorded as an intrusion rather than silently applied;
- takeover aborts at a safe boundary before transferring the lease;
- forced takeover records an interrupted boundary;
- handback resumes the same spec or proposes a new confirmed revision;
- a credential issued by `sf takeover` stops working the moment control is released, by handback or by `set_spec`;
- a permission event is denied and recorded;
- reconnecting to OpenCode does not duplicate a prompt whose completion is uncertain;
- an OpenCode version mismatch prevents autonomous work.

**Exit criteria**

- The integration suite uses the real OpenCode server and plugin without paid model access.
- All automation uses the HTTP API and events; PTY keystrokes are not a control path.
- Seat identity and lease state survive Swordfish restart.
- Failure of the plugin lease-guard assumption blocks the MVP rather than silently weakening control.

### Milestone 8: Cockpit and Human Control

**Work**

- Create the Swordfish-owned named tmux session and deterministic pane layout.
- Render the status TUI from durable Swordfish state.
- Start seat panes, shell panes, and configured service-log panes.
- Disable tmux input for Swordfish-controlled seat panes.
- Keep the seat server's password out of the tmux session environment and shell profiles, since `opencode attach` defaults `--password` to `OPENCODE_SERVER_PASSWORD`.
- Disable the embedded web UI, mDNS discovery, and extra CORS origins in the base image.
- Route takeover, handback, retry, extension, approval, and stop through `sf`.
- Print the seat URL, session ID, and lease owner in `sf status`, and never the seat credential.
- Issue the attach credential only through `sf takeover`, and revoke it on release.
- Preserve observation while preventing accidental terminal steering.
- Add SSH attach metadata to the local fake lifecycle provider.

**Exit criteria**

- A user can observe a working seat but cannot type into its pane while Swordfish holds the lease.
- The plugin rejects prompts from a second OpenCode client even if tmux is bypassed.
- Safe and forced takeover visibly update the pane, lease, status, and event stream.
- Disconnecting SSH does not imply handback, and leaves no usable seat credential behind.
- A second client attached during takeover loses write access at handback without Swordfish touching that client.

### Milestone 9: exe.dev Provisioning and Authentication

**Work**

- Implement the exe.dev lifecycle client with narrowly scoped credentials.
- Create VMs from a versioned base image and tag them by bounty.
- Attach only the selected repository, LLM, OpenCode Go proxy, and context integrations.
- Bootstrap Swordfish with a bounty-scoped credential and expected VM identity.
- Return SSH and private preview metadata.
- Add provisioning progress and idempotent recovery.
- Add orphan reconciliation without deleting unknown VMs immediately.
- Run the OpenCode Go HTTP Proxy smoke tests from `SPEC.md`.

**Exit criteria**

- A real smoke bounty reaches `interactive` from one CLI command.
- Repeating a create or recovery operation does not create another VM or branch.
- The VM cannot read reusable provider, GitHub, or exe.dev credentials.
- A failed proxy header, stream, cancellation, or path test blocks faye provisioning.

### Milestone 10: GitHub, Gates, QA, and Evidence

**Work**

- Add Bebop GitHub App authentication and repository installation selection.
- Create the assigned branch and draft pull request idempotently.
- Push validated candidates through the exe.dev repository integration.
- Poll checks for the exact candidate SHA.
- Run jet review and faye QA with their fixed capability profiles.
- Route blocking findings back to ein and invalidate all gates on a new commit.
- Implement the local filesystem CAS, per-blob negotiation, manifests, and metadata transaction.
- Publish the ready summary and evidence links to the pull request.
- Recheck readiness and branch head before explicit squash merge.
- Deprovision after the configured grace period.

**Exit criteria**

- One real test repository completes implementation, validation, CI, review, QA, evidence, and explicit merge.
- A failing gate returns to the original ein seat and a later SHA reruns every downstream gate.
- A push after readiness removes readiness before merge can proceed.
- Evidence downloads verify every SHA-256 and remain available after the bounty VM is deleted.

### Milestone 11: Recovery, Operations, and Release Qualification

**Work**

- Add restart reconciliation for every externally visible operation.
- Add command and event replay metrics, stale-connection alerts, and stage timings.
- Add artifact pruning, orphan blob cleanup, VM orphan reconciliation, and retention jobs.
- Add encrypted off-VM backups and sampled restore tests.
- Add container health checks, migrations, Compose deployment, and Caddy routing.
- Add the blue/green deployment procedure.
- Qualify a versioned base image with a smoke bounty before promotion.
- Measure Swordfish memory, CPU, event-loop delay, descriptors, SQLite latency, and child-process leakage.

**Exit criteria**

- Kill tests at every durable-intent/external-side-effect boundary do not duplicate VMs, prompts, PRs, evidence, or merges.
- A documented restore drill rebuilds Bebop metadata and evidence from backup.
- A promoted image has passed repository hooks, OpenCode, cockpit, proxy, and full smoke-bounty checks.
- The complete `SPEC.md` MVP acceptance flow has a recorded passing run.

## 7. CI Profiles

### Pull request

- frozen Bun install;
- formatting check;
- type-aware lint and type check;
- unit tests;
- Postgres and SQLite component tests;
- Git and repository-hook integration tests;
- Bebop-Swordfish process-level end-to-end tests;
- pinned OpenCode integration tests using the fake model endpoint;
- commitlint for the pull-request commit range.

### Main branch

- all pull-request checks;
- container and standalone executable builds;
- migration-from-previous-version tests;
- repeated protocol and hook stress tests;
- artifact retention for failed process-level tests.

### Credentialed scheduled or release checks

- exe.dev VM create, attach, reconnect, stop, and destroy;
- OpenCode Go HTTP Proxy smoke tests;
- GitHub App branch, draft PR, checks polling, comment, and cleanup;
- private preview access;
- full smoke bounty against a dedicated repository;
- backup and sampled restore.

## 8. Fixture Strategy

Keep fixtures under `packages/testkit/fixtures` and version them like production inputs.

Required fixtures include:

- minimal valid `.bebop/` repository;
- every hook failure mode from Milestone 6;
- a repository with a simple browser QA service;
- fake OpenAI-compatible streaming server scripts;
- valid and invalid Bebop-Swordfish protocol transcripts;
- prior SQLite and Postgres schema versions for migration tests;
- evidence blobs with duplicate content, hash mismatches, and interrupted uploads;
- a GitHub smoke repository outside the Bebop source repository.

Fixture setup must not depend on the developer's global Git identity, shell configuration, tmux configuration, OpenCode configuration, or occupied ports.

## 9. Definition of Done

A milestone is complete only when:

- its production path is reachable through a real entrypoint;
- schemas validate every external boundary;
- success, expected failure, restart, and cancellation behavior are tested;
- resources are cleaned after success and failure;
- logs identify the bounty and operation;
- the relevant `SPEC.md` acceptance criteria are demonstrably closer to passing;
- `vp run ready` passes from a clean checkout;
- the plan is updated when implementation invalidates an assumption.

The MVP is complete when Milestone 11 passes and all acceptance criteria in `SPEC.md` section 27 have a corresponding automated test, provider smoke test, or explicitly documented manual inspection step.

## 10. Immediate Execution Order

Start with these pull requests:

1. `chore(repo): initialize bun and vite-plus monorepo`
2. `feat(contracts): define bounty and swordfish protocols`
3. `feat(bebop): add postgres-backed api skeleton`
4. `feat(swordfish): add sqlite daemon and sf control client`
5. `test(protocol): exercise bebop and swordfish reconnects`
6. `feat(swordfish): execute clean-room repository hooks`
7. `test(swordfish): cover repository hook failures`
8. `feat(plugin): add opencode workflow tools and lease guard`
9. `feat(swordfish): integrate pinned opencode server events`
10. `test(opencode): cover seats prompts abort and restart`

Keep each pull request independently runnable. Do not combine real exe.dev provisioning with the first Bebop-Swordfish protocol implementation.
