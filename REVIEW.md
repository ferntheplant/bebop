# Milestone 4 PR Review

Reviewed `origin/main...HEAD` at `b42dd9f` against `PLAN.md` Milestone 4 and the relevant persistence,
recovery, protocol, control, and implementation requirements in `SPEC.md`.

## Verdict

The initial review found seven high-severity issues and concluded that Milestone 4 should not be marked complete yet.
All seven high-severity findings are resolved in the current working tree. All five medium-severity findings and the
single low-severity finding are also resolved in this remediation pass.

The PR establishes a substantial core: real SQLite persistence, transactional event/outbox writes, a real outbound
WebSocket client, a permission-checked Unix control socket, a socket-only `sf` CLI, packed artifacts, and tests over
real SQLite/socket/process boundaries. `vp run ready` passes.

The remediation pass closed every open finding. Control requests now produce a correlated `internal_error` response on
expected typed failures instead of closing the connection silently. Shutdown is bounded by `SWORDFISH_SHUTDOWN_TIMEOUT`.
The test harness acquires the database-derived authority lock before migrating SQLite, reconciliation coverage uses a
real child process and worktree, the fake WebSocket peer contract-decodes every outbound frame, behavioral control
coverage exercises takeover through approve-config, and the Effect package stack is coherently pinned to one beta.
Transport logs carry the durable identity and the reconnect warning reports the typed session failure. The protocol
error model was tightened: malformed and oversized peer traffic is a typed session failure (not a defect), every session
end is a typed failure, and inbound-queue saturation uses a WebSocket close code Bun actually transmits.

## Findings

### High Severity

#### 1. [Resolved] Startup reconciliation records uncertainty but resumes the old workflow anyway

Resolution: reconciliation row updates and a durable `attention_required` event now commit in one startup transaction.
The daemon enters `needs_attention` before starting transports, and the component test asserts the workflow status and
event as well as the reconciliation row.

References: `apps/swordfish/src/persistence/store.ts:471-523`, `apps/swordfish/src/workflow/service.ts:91-99`,
`apps/swordfish/src/daemon.ts:25-38`, `PLAN.md:412,434`, `SPEC.md:1475-1487`.

`reconcileLocalState` changes auxiliary reconciliation rows to `needs_attention` or `unknown`, but it emits no workflow
event, does not move the workflow to `needs_attention`, and does not return a result that can stop startup. The daemon
then starts both transports and reports the previous stage to Bebop. `SfStatusSnapshot` exposes none of the
reconciliation rows, so the operator cannot see the uncertainty through `sf status` either.

This violates the restart rule that Swordfish "resumes only after it can prove the current stage." A surviving child,
vanished worktree, or operation with unknown completion must block normal resumption or durably move the workflow to
`needs_attention` before reconnecting.

The component test at `apps/swordfish/test/component/persistence.test.ts:117-134` reinforces the gap: it checks only
that one injected row changes status, not that workflow execution is blocked or that status surfaces the condition.

#### 2. [Resolved] The reconnect loop converts defects into endless transport retries

Resolution: the loop uses `Effect.result`, retries only `BebopSessionError` and `SocketError`, and propagates defects,
SQL failures, and failed disconnect bookkeeping to process supervision. A component test proves a durable bookkeeping
defect terminates after one connection rather than reconnecting.

References: `apps/swordfish/src/protocol/client.ts:224-252`, especially `:232-245`; `PLAN.md:186,416`.

`Effect.exit(session(...))` captures the complete cause, including defects and interruption, and the loop then ignores
the cause, marks the connection disconnected, sleeps, and retries. The follow-up `catchCause` also suppresses every
failure while recording the disconnect. A decoder defect, invariant failure, or SQLite defect therefore leaves a
half-healthy daemon reconnecting forever instead of failing for its external supervisor.

This is the principal non-idiomatic Effect v4 use in the PR. The pinned v4 source documents that `Effect.exit` captures
typed failures, defects, and interruption, while `Effect.retry` retries typed failures and deliberately does not retry
defects or interruption. The reconnect policy should retry only the expected transport/session error channel and let
defects and durable-authority failures terminate the daemon.

The current warning log records only `outcome._tag`, which is always `Failure` for all of these cases, so the swallowed
cause is not even observable.

#### 3. [Resolved] The single-daemon lock is not bound to the SQLite authority

Resolution: Swordfish acquires a deterministic private Unix lock socket beside the configured database before acquiring
the independently configurable control socket. The packed-process test starts a competing daemon against the same
database with another control path and proves it exits without displacing the owner.

References: `apps/swordfish/src/config.ts:40-43,57-64`, `apps/swordfish/src/control/server.ts:277-285`,
`apps/swordfish/src/daemon.ts:23-27`, `PLAN.md:427-428`.

The control socket is described as the single-daemon lock, but `databasePath` and `controlSocketPath` are independent
configuration values. Two daemons can use the same database and identity with different socket paths; both acquire
their socket, pass metadata validation, migrate/reconcile the same SQLite authority, accept local commands, and open a
Bebop connection.

The lock must be deterministically associated with the database authority, or SQLite needs an independent authority
lock. The current component test at `apps/swordfish/test/component/control.test.ts:63-68` proves only that two servers
cannot bind the same socket path.

#### 4. [Resolved] Swordfish cannot replay from a regressed Bebop cursor

Resolution: registration accepts any peer cursor not beyond `lastProduced`, and delivery pages retained events after the
peer cursor regardless of their local acknowledgement flag. A real-WebSocket component test acknowledges sequence 1,
reconnects with cursor 0, and observes sequence 1 replayed.

References: `apps/swordfish/src/protocol/client.ts:107-115,127-135`,
`apps/swordfish/src/persistence/store.ts:279-285,303-326`, `SPEC.md:1239-1245`, `PLAN.md:430`.

The registration exchange fails whenever Bebop's cursor is behind local `acknowledgedThrough`. That turns a Bebop
restore or cursor rollback into an infinite reconnect loop. Even if the check were removed, `pendingEvents` filters on
`acknowledged = 0`, so retained acknowledged rows cannot be replayed from the peer's durable cursor.

`SPEC.md` says that after reconnecting Swordfish replays from Bebop's acknowledged cursor. The local outbox retains the
payloads, so the implementation should page events after the peer cursor regardless of the local acknowledgement flag,
while still rejecting cursors beyond `lastProduced`.

No test covers cursor regression. The protocol component always registers with `acknowledgedThrough: 0` while local
acknowledgement is also zero.

#### 5. [Resolved] Required durable state has schema but no production persistence path

Resolution: the store now exposes production operations for local artifact manifests, reconciliation start/completion,
and constraint consumption. The working-state restart test persists and reloads each surface through those operations.

References: `apps/swordfish/src/persistence/migrations.ts:90-115`,
`apps/swordfish/src/persistence/store.ts:69-96,471-523`, `PLAN.md:409,412`, `SPEC.md:1460-1473`.

`local_artifacts` has no store operation at all. `reconciliation_records` can be read and updated during startup but
cannot be created by production code; its only writer in the repository is direct SQL in a component test. Constraint
rows can be initialized and extended but have no consumption operation. As a result, production code cannot establish
some of the durable facts that Milestone 4 claims to persist and reconcile.

Tables alone do not satisfy the persistence requirement. Add production operations that commit these records with the
workflow operation they describe, then exercise their restart behavior.

#### 6. [Resolved] The SIGKILL test does not prove replay after a process restart

Resolution: the packed daemon now connects to a real fake WebSocket peer in the process test. The peer observes sequence
1, the test sends SIGKILL before acknowledgement, the restarted process replays sequence 1, and the peer acknowledges it
before packed `sf status` verifies the durable cursor and empty pending count.

References: `test/integration/entrypoints.test.ts:226-281`, especially `:241,255-271`; compare
`apps/swordfish/test/component/protocol.test.ts:101-149`; `PLAN.md:418-421`.

The packed daemon process is pointed at `127.0.0.1:1`, so no peer receives an event before or after restart. The test
asserts only that the pending SQLite row remains visible through `sf status`. The WebSocket component test separately
proves replay after reconnect, but it calls `runBebopClient` directly and never restarts the daemon/runtime.

A regression where the restarted daemon never starts the protocol client would pass both tests. The exit criterion is
the composition: commit an event, kill the process before acknowledgement, restart the packed daemon, observe the same
sequence at a real fake peer, acknowledge it, and verify the durable cursor/outbox.

#### 7. [Resolved] Nontrivial Swordfish authority is not tested across restart

Resolution: a component test now persists and restores a lease, effective spec, candidate, failed validator outcome and
feedback, constraint consumption and extension, local artifact manifest, completed reconciliation record, and command
result. The fixture also exposed and closed two nested Schema encoding defects in event append and status projection.

References: `apps/swordfish/test/component/persistence.test.ts:35-75`,
`test/integration/entrypoints.test.ts:255-271`, `apps/swordfish/src/persistence/workflow-snapshot.ts:26-89`,
`PLAN.md:408-410`, `SPEC.md:1460-1485`.

Every restart assertion covers only the bootstrap `interactive` event and snapshot. There is no restart round trip for
seat identities and leases, an effective spec, a candidate, gate outcomes and findings, a changed constraint ledger,
local artifacts, or a stored command result. The snapshot codec itself has no direct round-trip test.

The current tests can stay green if bootstrap restoration works but real in-progress workflow authority is corrupted,
omitted, or reconstructed inconsistently. A useful durability fixture should persist a representative nontrivial state,
close and rebuild the layer or process, and assert both normalized status and relevant history rows.

### Medium Severity

#### 8. [Resolved] Valid control requests can terminate without a protocol response

Resolution: once a request is decoded, `connectionHandler` translates `SqlError` and `WorkflowTransitionError` into a
schema-valid `internal_error` response on the request's correlation id. `CommandConflictError` continues to map to
`correlation_conflict`. Defects still escape to supervision. A real-socket component test sends a `stop` command against
a fake workflow service that fails `applyCommand` and asserts the correlated `internal_error` response.

References: `apps/swordfish/src/control/server.ts:115-135,255-275`, `apps/swordfish/test/component/control.test.ts`.

Only `CommandConflictError` is translated at the connection boundary. SQL failures, workflow transition failures, and
other typed failures escape `connectionHandler`; the server closes the connection and `sf` reports a transport error.
The contract includes `internal_error`, but the server never emits it.

Once a request is decoded and has a correlation ID, expected internal failures should produce a schema-valid,
correlated error response. Defects may still terminate the handler/process according to the supervision policy.

#### 9. [Resolved] `SWORDFISH_SHUTDOWN_TIMEOUT` is parsed but never used

Resolution: the daemon now manages its scope manually. After the main effect exits (success, failure, or interruption),
scope finalizers run in a detached daemon fiber raced against `config.shutdownTimeout`. If finalization exceeds the
timeout, the daemon logs a warning and abandons the remaining finalizers; `BunRuntime.runMain` exits once the main fiber
completes.

References: `apps/swordfish/src/daemon.ts:18-74`.

Shutdown relies on unbounded scope finalization even though configuration requires a positive shutdown timeout. A stuck
socket/server finalizer can exceed the supervisor's grace period, and the documented configuration value has no effect.
Apply a bounded finalization policy or remove the unsupported setting.

#### 10. [Resolved] Reconciliation and lock integration tests bypass the production conditions they claim to validate

Resolution: the test harness now acquires the database-derived authority lock before migrating or bootstrapping SQLite,
matching production startup ordering. A component test starts a second harness over the same `databasePath` and asserts it
fails at the lock. The reconciliation test spawns a real child process and creates a real worktree directory, restarts,
and asserts surviving and vanished records are marked `needs_attention` and `unknown` respectively.

References: `apps/swordfish/test/component/support/harness.ts`, `apps/swordfish/test/component/control.test.ts`,
`apps/swordfish/test/component/persistence.test.ts`.

The harness migrates and bootstraps SQLite before any control socket is acquired, unlike production startup. The
second-daemon check starts another socket server in the same already-bootstrapped runtime rather than a second daemon
process. The reconciliation test uses a hard-coded PID `123`, does not create a real child or worktree, and can produce a
different result if that PID exists on the host.

There is no integration test with a real child process, real temporary worktree/path, or two daemon processes sharing
one authority. Those are the boundaries named by the milestone, and they are where startup ordering and fail-closed
behavior matter.

#### 11. [Resolved] Protocol and CLI coverage is materially narrower than the completion claims

Resolution: the fake WebSocket peer contract-decodes every outbound frame through `SwordfishToBebopMessage` and the tests
assert registration, heartbeat, command-result identity, and cursor fields exactly. New protocol tests cover wrong
identity, acknowledgement beyond the produced frontier, malformed frames, oversized frames, repeated registration, and
queue saturation. New control tests exercise takeover, handback, extend, retry, and approve-config over a real socket,
and reject a valid success response with the wrong correlation id or command. `PLAN.md` is updated to reflect the
broadened coverage.

References: `apps/swordfish/test/component/protocol.test.ts`, `apps/swordfish/test/component/control.test.ts`.

The fake WebSocket peer parses outbound traffic as unchecked `Record<string, unknown>` and branches mostly on `type`.
It does not contract-decode or exactly assert registration, heartbeat, or command-result identity and cursor fields.
Wrong identity, acknowledgement ahead/regression, malformed frames, oversized frames, repeated registration, and queue
saturation are not covered.

Process/CLI coverage exercises help, absent-daemon status, trailing-argument rejection, packed status, and packed stop.
There is no behavioral CLI/control coverage for takeover, handback, extend, retry, or approve-config. The completion note
claims wrong correlation/command coverage, but the new real-socket test sends only a structurally malformed response;
no valid success response with the wrong command is tested.

The existing tests are useful, but `PLAN.md` overstates what they establish.

#### 12. [Resolved] The installed Effect packages are not actually on one compatible beta

Resolution: the root `package.json` overrides `@effect/platform-node-shared` to `4.0.0-beta.101`, matching the catalog
pins for `effect` and `@effect/platform-bun`. The lockfile resolves only `@effect/platform-node-shared@4.0.0-beta.101`.

References: `package.json:26-28`, `bun.lock:144,233`.

The catalog pins Effect and `@effect/platform-bun` to `4.0.0-beta.101`, but the lock resolves
`@effect/platform-node-shared@4.0.0-beta.102`, whose peer dependency requires `effect@^4.0.0-beta.102`. Swordfish now
directly exercises the Bun socket modules that load this unsupported cross-beta combination.

This mismatch already exists on `origin/main`, so it is not introduced by the PR, but it prevents an unconditional
confirmation that the runtime is on a coherent pinned Effect v4 stack. Pin the transitive package to beta.101 or upgrade
all Effect packages together.

### Low Severity

#### 13. [Resolved] Structured transport logs omit durable identity and useful failure causes

Resolution: `Effect.annotateLogs({ bounty_id, vm_id })` wraps the entire daemon effect, so every log — including
registration, heartbeat, and reconnect logs from forked transport fibers — inherits the durable identity. The reconnect
warning logs the typed failure's tag and reason (and its cause for `BebopSessionError`) instead of just the outcome tag.

References: `apps/swordfish/src/daemon.ts:43-46`, `apps/swordfish/src/protocol/client.ts:221-263`.

`bounty_id` and `vm_id` annotate only the single startup log call, not the daemon or transport effect. Registration and
reconnect logs therefore omit the required identity. The reconnect warning logs only whether the captured `Exit` was a
success or failure and discards its cause. Apply log annotations around the long-lived daemon effect and log the typed
session failure/cause at the retry boundary.

## Effect v4 Assessment

Most of the code uses APIs and patterns that are current in the pinned Effect 4 beta:

- `Context.Service` is a supported v4 service definition style in the installed source.
- `Data.TaggedError`, `Layer.effect`, `Layer.unwrap`, and explicit service requirements provide typed composition.
- `Effect.forkScoped`, `Effect.scoped`, and socket/server scopes give transport fibers structured lifetime.
- Effect Schema decodes protocol and persisted snapshot payloads at their boundaries.
- `effect/unstable/cli`, `effect/unstable/socket`, and `effect/unstable/sql` match the repository's chosen v4 modules.
- Time and correlation IDs are behind an Effect service and are replaceable in tests.
- SQL command application, event writes, snapshots, entity histories, command results, and outbox writes are grouped in
  transactions.

The code is therefore broadly v4-native, not an Effect 3 compatibility implementation. The remediation pass closed the
two error-model gaps the assessment identified:

- **The reconnect loop no longer erases the defect boundary.** It uses `Effect.result`, retries only `BebopSessionError`
  and `SocketError`, and propagates defects, SQL failures, and failed disconnect bookkeeping to process supervision.
  `decodeFrame` and `verifyIdentity` now return `Effect.fail(BebopSessionError)` instead of throwing, so malformed or
  oversized peer traffic is a typed session failure that reconnects rather than a defect that crashes the daemon. Every
  session end is a typed failure — a clean socket close is mapped to `BebopSessionError` inside `session`, unifying the
  reconnect loop so it never distinguishes "success-with-retry" from "failure-with-retry." The explicit `for (;;)` loop
  is retained over `Effect.retry` because `Schedule.resetAfter` (needed to reset backoff after a healthy registration)
  is not available in this v4 beta; the explicit loop with `Effect.result` already follows the error-model idiom.
- **The cross-beta dependency resolution is corrected.** The root `package.json` overrides
  `@effect/platform-node-shared` to `4.0.0-beta.101`, and the lockfile resolves only that version.

A secondary fix emerged from the error-model work: inbound-queue saturation previously closed the WebSocket with code
1013 ("Try Again Later"), which is reserved for intermediary proxies per RFC 6455 and is not transmitted by Bun's
WebSocket client (it arrives as 1006 / abnormal). The close code is now 1008 (Policy Violation), a standard endpoint
code the peer receives correctly.

The daemon's scope finalization was also tightened to follow the v4 resource idiom: rather than relying on
`Effect.scoped` with unbounded finalizers, the daemon manages its scope manually and races `Scope.close` against
`SWORDFISH_SHUTDOWN_TIMEOUT` in a detached fiber, so a stuck socket close cannot outlive the supervisor's grace period.

Direct `node:fs`, `node:net`, `process.kill`, and global clock/random calls are wrapped in effects or an app service, so
they are not by themselves correctness findings here. Using Effect platform filesystem/path services would improve
typed platform errors and test substitution, but the real-filesystem tests provide reasonable coverage for the current
small surface.

## Test Layer Assessment

| Layer                      | What exists                                                                                                                                                                      | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                       | 10 Swordfish reducer tests and 2 config tests; the PR adds one initial-announcement reducer case and one config assertion. Shared workflow tests cover the pure transition core. | Useful reducer coverage, but little new unit coverage for snapshot serialization, command hashing/results, cursor policy, or reconciliation decisions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Component / contract-style | 5 SQLite tests, 5 Unix-socket tests, and 8 real-WebSocket/fake-peer tests.                                                                                                       | These use real SQLite files and real transports and are valuable. The high-severity recovery composition, nontrivial restoration, cursor regression, defect propagation, and fail-closed reconciliation gaps are covered. Outbound contract decoding is now exercised: the fake peer decodes every frame through `SwordfishToBebopMessage` and asserts identity, cursor, and correlation fields exactly. New robustness tests cover wrong identity, acknowledgement ahead, malformed/oversized/repeated-registration frames, and queue saturation. Behavioral control coverage exercises takeover, handback, extend, retry, and approve-config over a real socket, rejects a valid success response with the wrong correlation or command, proves a correlated `internal_error` on internal failures, and refuses a second runtime over the same SQLite authority. Reconciliation coverage uses a real child process and a real worktree directory. |
| Integration / process      | Swordfish source-process checks for CLI/config failure plus one packed SIGKILL/restart test.                                                                                     | Real processes are exercised. The packed SIGKILL/restart test now observes replay at a real fake WebSocket peer, and a competing daemon with another control path fails at the authority lock. No Bebop-Swordfish end-to-end test exists, appropriately deferred to Milestone 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Artifact smoke             | `apps/swordfish/scripts/smoke.ts` starts packed daemon/CLI artifacts against a fresh SQLite database, calls packed status, and stops through the packed CLI.                     | Useful proof that bundled migration loading and basic artifacts work. It is a happy-path smoke, not recovery or integration coverage. The CLI helper has no timeout, so a hung packed CLI can hang `ready`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The test suite is not superficial: it exercises real boundaries and catches meaningful regressions. The strongest
guarantees still concern behavior across multiple boundaries, while the suite generally tests each boundary in isolation,
but the remediation pass broadened both the contract-decoded component coverage and the process-level recovery
composition.

## Validation Performed

- `vp install`: passed (lockfile updated to pin `@effect/platform-node-shared` to beta.101).
- `vp run ready`: passed.
- Unit/component run: 242 passed, 58 skipped; all Swordfish tests ran (33 Swordfish tests across 6 files).
- Integration run: 8 passed, 2 skipped; all Swordfish process tests ran.
- Swordfish packed artifact smoke: passed.
- Formatting, linting, and type checking: passed with no warnings or errors.

The 58 skipped unit/component tests and 2 skipped integration tests are Postgres-backed Bebop tests and do not reduce
the Swordfish-specific execution described above.
