# Milestone 3 Implementation Review

Reviewed `origin/main...770d6ea` against `SPEC.md`, `PLAN.md` Milestone 3, the pinned Effect 4 beta APIs, and the tests added by this PR.

## Resolution Status

All critical, high, and medium findings below have been addressed in the current worktree. The two architecture
decisions were made explicitly: fresh installations use a one-shot environment bootstrap token, and provisioning
retries derive a stable bounty credential from a deployment HMAC key. `SPEC.md`, `PLAN.md`, and `README.md` now
record both invariants.

The repaired suite now exercises ordered concurrent frames, stale-sweep fencing, reclaimable worker leases,
uncertain command delivery, VM-bound registration, credential revocation, recovery, token lifecycle, provider
failure before and after side effects, retry exhaustion, stop/provision races, SSE pagination and live handoff,
CLI idle reconnect, protocol failure boundaries, bounded shutdown, and packed API/worker restart over one real
Postgres.

The original implementation had a solid contract-first shape, useful pure reducers, real Postgres component tests, and several strong targeted tests. In particular, concurrent create idempotency, authorised middleware execution, duplicate event projection, replaced-connection fencing in the sequential case, and CLI process execution were tested at meaningful boundaries. However, that suite passed while several durability and authentication guarantees were false. The findings below are retained as the record of what was found and repaired.

## Critical Findings

### [x] C1. Projection updates can overwrite already-acknowledged events

**Resolution:** Projection application now reloads under a per-bounty transaction lock and rechecks freshness against the sweep cutoff.

**Where:** `apps/bebop/src/service/projection.ts:42-78`, `apps/bebop/src/persistence/swordfish.ts:119-157`, `apps/bebop/src/worker/jobs.ts:173-186`

`applyProjectionInput` receives a snapshot loaded by its caller, reduces that snapshot before opening a transaction, and then unconditionally replaces the projection row. The transaction protects the writes derived from that snapshot, but not the read/reduce decision. There is no row lock, version predicate, sequence predicate, or retry.

A concrete data-loss race is:

1. The worker loads sequence 5 as a stale candidate.
2. The gateway applies sequence 6, commits it, publishes it, and acknowledges sequence 6 to Swordfish.
3. The worker saves its old sequence-5 snapshot with `freshness = stale`.
4. Swordfish has discarded sequence 6, while Bebop now rejects sequence 7 as a gap.

The same lost-update problem exists between heartbeats, events, reconnects, and disconnect reconciliation. This violates `SPEC.md` sections 9.3, 18.3, and 22.4 and defeats the connection fencing that the reducer itself implements.

Load and lock the current projection inside the same transaction that reduces and saves it. A per-bounty advisory lock, `SELECT ... FOR UPDATE` with an explicit absent-row strategy, or optimistic version/sequence compare-and-retry would all make the decision atomic. Add deterministic barrier-based tests for stale-sweep versus heartbeat and old-connection event versus replacement registration.

### [x] C2. WebSocket frames are processed concurrently even though the gateway requires strict ordering

**Resolution:** Frames enter a bounded queue and one scoped consumer processes them in arrival order.

**Where:** `apps/bebop/src/swordfish-gateway/gateway.ts:99-100`, `apps/bebop/src/swordfish-gateway/gateway.ts:137-228`, `apps/bebop/src/swordfish-gateway/gateway.ts:283-313`

The pinned Bun HTTP adapter implements `Socket.runString` by starting each frame handler in a `FiberSet`. Frames therefore execute concurrently. The gateway assumes the opposite: it mutates `session`, loads/replaces one projection, acknowledges ordered events, and drains commands without any serialization.

Back-to-back sequence 1 and sequence 2 frames can both load sequence 0, causing a false gap or a later stale save. A heartbeat can overwrite an event snapshot. Concurrent registrations can race on `session`. A fast peer can also create an unbounded number of active SQL-backed handler fibers.

Feed decoded frames into a bounded `Queue` with one scoped consumer, or serialize the complete frame operation with a one-permit semaphore and close/backpressure on overflow. The queue bound should implement the bounded-message behavior required by the protocol design. Add a test that sends consecutive events without waiting for each acknowledgement and asserts ordered application under repeated runs.

### [x] C3. A worker crash permanently strands a claimed lifecycle job

**Resolution:** Job claims are renewable, expiring leases fenced by worker and attempt identity.

**Where:** `apps/bebop/src/persistence/jobs.ts:116-132`, `apps/bebop/src/worker/jobs.ts:114-159`, `apps/bebop/src/worker.ts:25-48`

Claiming commits `status = 'running'`, but subsequent claims select only `pending` rows. `locked_at` is written and never used as a lease. A process exit, interruption, defect, or machine restart after claim and before `complete`/`fail` leaves the job in `running` forever.

This directly contradicts `SPEC.md` section 22.4, which requires Bebop to resume provisioning and cleanup after restart. It also makes the comment in `jobs.ts:3-7` false: durable intent exists, but no process can resume it.

Make claims expiring leases and reclaim stale `running` rows, preferably with a fencing attempt/lease identity so a late first worker cannot complete work reclaimed by a second. Test real worker termination after claim and after the provider side effect, then restart the worker and assert one VM, one completed job, and a terminal bounty state.

### [x] C4. A command can be lost after the socket write and before Swordfish durably receives it

**Resolution:** Commands remain deliverable until Swordfish reports `accepted` or a terminal result.

**Where:** `apps/bebop/src/swordfish-gateway/gateway.ts:101-125`, `apps/bebop/src/persistence/commands.ts:117-131`, `apps/bebop/test/component/gateway.test.ts:240-273`

The gateway marks a command delivered immediately after a local WebSocket write, and future drains select only `delivered_at IS NULL`. A successful write means bytes entered the local socket path; it is not a peer acknowledgement. If the connection drops before Swordfish stores the command, reconnect excludes it forever.

This violates the at-least-once and offline behavior in `SPEC.md` sections 18.3-18.4. It also contradicts the repository comment that uncertain disconnects are safe to redeliver.

Continue delivering until Swordfish reports at least `accepted` or a terminal result. Keep `delivered_at` as observational metadata rather than the exclusion predicate, and rely on `commandId` for duplicate suppression. The current test sends `completed` before reconnect and therefore proves only that a completed command is not resent; add a disconnect immediately after write and require the same `commandId` on reconnect.

## High Findings

### [x] H1. The bounty credential is not bound to the provisioned VM

**Resolution:** Gateway authentication resolves a live bounty/VM mapping and registration must match both identities.

**Where:** `apps/bebop/src/swordfish-gateway/gateway.ts:78-87`, `apps/bebop/src/swordfish-gateway/gateway.ts:137-165`, `apps/bebop/src/persistence/swordfish.ts:127-130`, `apps/bebop/src/persistence/bounties.ts:208-212`

Authentication resolves only a bounty ID. Registration never reads `vm_mappings`; on the first connection, `projections.load` creates an initial projection from the client-supplied `vmId`. Even an existing sequence-zero projection can be rebound because the mismatch check is conditional on `lastAppliedSequence > 0` and line 163 overwrites the VM ID.

A leaked bounty token can therefore register `vm-attacker` before the legitimate VM emits an event and be accepted as the authority. This violates the explicit bounty-to-VM binding in `SPEC.md` section 18.2.

Load the live VM mapping at registration and require an exact bounty/token/VM match before assigning `session` or mutating the projection. Add tests for an attacker VM both before any legitimate registration and after a legitimate sequence-zero registration.

### [x] H2. `recover` does not enqueue work, and repeated terminal operations regress state

**Resolution:** Recovery re-arms terminal provision jobs, while repeated stop, destroy, recovery, and approval calls are idempotent.

**Where:** `apps/bebop/src/api/handlers.ts:182-227`, `apps/bebop/src/persistence/jobs.ts:104-114`, `apps/bebop/test/component/events.test.ts:54-74`

Every bounty already owns `provision:<bountyId>`. `enqueue` turns a dedupe conflict into a no-op regardless of whether the old row is `succeeded` or `failed`. `recover` then changes the bounty to `provisioning`, but no runnable job exists. The same pattern lets a repeated destroy move a destroyed bounty back to `destroying` while its succeeded destroy job remains inert.

Define legal lifecycle transitions and an explicit re-arm/new-attempt operation. Recovery needs an attempt-specific job identity while provider idempotency remains bounty-scoped. Terminal repeated operations should be idempotent and must not regress lifecycle state.

The only current recovery exercise invokes the endpoint to generate an SSE event and never runs jobs or asserts recovery. Add a test that loses/stops a provisioned VM, calls recover, runs or restarts the worker, and proves that the bounty leaves `provisioning` without creating a duplicate VM.

### [x] H3. Deprovisioning leaves the Swordfish credential usable

**Resolution:** Destruction revokes the stored hash transactionally and authentication requires a live VM mapping.

**Where:** `apps/bebop/src/worker/jobs.ts:91-105`, `apps/bebop/src/persistence/bounties.ts:232-249`, `apps/bebop/src/swordfish-gateway/gateway.ts:78-87`, `apps/bebop/test/component/lifecycle.test.ts:104-116`

Destroy marks the VM mapping and lifecycle state, but leaves `swordfish_token_hash` intact. Gateway authentication checks neither the bounty lifecycle nor `destroyed_at`. A caller retaining the old credential can reconnect after destruction and continue mutating the projection.

`SPEC.md` section 18.2 explicitly says the token is bounded by the bounty lifetime and revoked at deprovisioning. Clear the hash atomically with destruction and reject gateway upgrades unless the mapped VM is live. Extend the destroy test to reconnect with the captured old token and require rejection with no projection mutation.

### [x] H4. A fresh deployment has no supported way to create its first API token

**Resolution:** An empty token table requires a one-shot redacted bootstrap token that is never reapplied later.

**Where:** `apps/bebop/src/api/server.ts:38-43`, `apps/bebop/src/api/handlers.ts:231-275`, `apps/bebop/src/persistence/migrations.ts:58-67`, `apps/bebop/test/component/support/harness.ts:152-163`

Every token route is bearer-authenticated, migrations create an empty token table, and there is no startup bootstrap credential or administrative command. A new deployment can answer health checks but cannot authenticate any state-bearing request, including `POST /api/tokens`.

The harness hides this by calling `ApiTokenRepository.create` directly, a capability no deployed client has. Add a secure one-shot bootstrap path or an explicit deployment-time administrative command, and test a new database through that supported path rather than seeding the repository behind the API.

### [x] H5. Lifecycle state, durable intent, approvals, and client events are separate commits

**Resolution:** Each mutation now commits its intent, state, approval, and visible event in one locked transaction.

**Where:** `apps/bebop/src/api/handlers.ts:134-143`, `apps/bebop/src/api/handlers.ts:163-227`, `apps/bebop/src/service/bounties.ts:282-310`

Effect sequencing does not make SQL operations atomic. Stop queues a command and then changes lifecycle state. Recover/destroy enqueue a job and then change lifecycle state. Approval writes the approval and then queues a command. `transitionLifecycle` updates the bounty and appends its SSE event in separate transactions.

Failures between these commits produce states such as a delivered stop command with a non-stopping bounty, a destroy job with no destroying state, an approval Swordfish was never told about, or a lifecycle change absent from the event stream. Retrying can then add another command or event.

Put each application operation behind one service method and one `SqlClient.withTransaction` covering every durable row it owns. External provider calls should remain outside the transaction, but database intent and resulting database state must commit together. Add failpoint tests between each write and assert all-or-nothing behavior.

### [x] H6. Command results are neither bounty-scoped nor monotonic

**Resolution:** Results are bounty-scoped, unknown foreign commands fail, and terminal statuses cannot regress.

**Where:** `apps/bebop/src/swordfish-gateway/gateway.ts:248-264`, `apps/bebop/src/persistence/commands.ts:133-138`

The envelope identity is checked, but `recordResult` updates only by `command_id`. An authenticated Swordfish for bounty A can report a result for bounty B's command if it learns or guesses that ID. The update also blindly replaces status, so a delayed `accepted` replay can regress a `completed` command.

Scope the update by both command ID and the registered bounty, require a matching row, and enforce monotonic/idempotent transitions. Return a protocol error for unknown or foreign commands. Add cross-bounty, duplicate, out-of-order, and terminal-regression tests.

### [x] H7. The HTTP listener is acquired before migrations and startup reconciliation

**Resolution:** Server-layer acquisition is suspended until migrations, token bootstrap, and reconciliation finish.

**Where:** `apps/bebop/src/api.ts:27-44`, `apps/bebop/src/api.ts:52-69`, `apps/bebop/test/component/support/harness.ts:112-129`

`Effect.provide(ServerLayer)` acquires the layer before running the provided effect. The listener therefore exists before the generator executes `migrateDatabase` and `reconcileConnectionsOnStartup`, despite the comments claiming the opposite. The test harness makes the ordering especially visible: it builds the server layer at line 124 and migrates at line 127.

Requests can hit missing tables or observe inherited connections as live during startup. If migration fails, the process may briefly expose a listener before teardown.

Build/provide the database runtime first, run migrations and reconciliation, and only then acquire the server layer around the long-lived effect. Add a startup barrier test proving that the port is not reachable until migration and reconciliation complete.

### [x] H8. A stale or disconnected Swordfish still appears `autonomous` or `ready`

**Resolution:** Compact status now incorporates freshness and degrades active claims to `needs_attention`.

**Where:** `apps/bebop/src/service/bounties.ts:87-107`, `apps/bebop/src/domain/bounty.ts:61-114`

Compact status is derived only from lifecycle state and the last Swordfish stage. Freshness is returned as a separate field but never affects status. A bounty whose last stage was `implementing` or `ready` continues to report `autonomous` or `ready` after becoming stale/disconnected.

This is the exact behavior `SPEC.md` section 9.3 forbids: a disconnected Swordfish cannot be presented as currently working merely because its last event said it was. Include freshness in compact-status derivation so inactive connections degrade active/ready claims, normally to `needs_attention`, and assert both fields after stale detection and restart.

### [x] H9. The provisioning credential is not durable across the external side effect

**Resolution:** Bounty credentials are retry-stable HMAC derivations; Postgres continues to store only hashes.

**Where:** `apps/bebop/src/worker/jobs.ts:55-84`, `apps/bebop/src/lifecycle/provider.ts:42-59`

Provisioning mints the credential in memory, calls the external provider, and stores its hash afterward. A crash or SQL failure after the provider succeeds loses the credential that was injected into the VM. A retry mints a different token; an idempotent provider is allowed to return the existing VM and is not required by this interface to replace its bootstrap credential, so Bebop can store a hash the VM does not possess.

Persist a stable provisioning attempt/credential before the side effect, derive it deterministically from protected durable material, or strengthen the provider operation to guarantee idempotent credential replacement. Test a crash after provider success and prove that the original VM can authenticate after worker restart.

## Medium Findings

### [x] M1. One transient SQL error permanently stops command polling for a socket

**Resolution:** Poll failures are handled per iteration, so the repeating fiber survives transient errors.

**Where:** `apps/bebop/src/swordfish-gateway/gateway.ts:272-281`

`Effect.repeat` stops on the first failure, and `Effect.ignore` is outside the repeat. A temporary database failure therefore ends the polling fiber successfully instead of allowing the next scheduled iteration. Commands may still move on a heartbeat, but the documented polling floor is gone until reconnect.

Handle/log failures per iteration before `repeat`, or use an explicit retry schedule with bounded backoff. Add a repository-failure injection test that proves polling resumes.

### [x] M2. Normal socket close never records `connection_lost`

**Resolution:** Socket scope finalization applies a connection-fenced `connection_lost` input immediately.

**Where:** `apps/bebop/src/swordfish-gateway/gateway.ts:283-323`

The socket scope ends without a finalizer applying `connection_lost` for its session. A cleanly closed connection remains `connected` until the worker threshold expires, and then becomes `stale` rather than `disconnected`. If the worker is delayed, the false connected state is unbounded.

Attach an `onExit`/finalizer that applies `connection_lost` using the session's connection ID. The reducer's connection fencing already makes cleanup from a replaced socket safe. Test ordinary close without restarting the API.

### [x] M3. The CLI exits when the server performs its intentional idle disconnect

**Resolution:** The CLI reconnects with bounded delay from its last successfully emitted cursor.

**Where:** `apps/bebop/src/config.ts:66-76`, `apps/bebop/src/cli/events.ts:63-92`, `apps/bebop/test/component/cli.test.ts:108-131`

The server deliberately closes quiet streams after at most 255 seconds and the configuration comment says clients reconnect with `Last-Event-ID`. `streamBountyEvents` instead returns when `reader.read()` reports `done`; it does not retain the latest cursor or reconnect.

As a result, `bebop bounty events` is not actually a tail command for a quiet bounty. Reconnect with bounded backoff from the last successfully decoded cursor and preserve interruption as the way to exit. The current test kills the process after 800 ms and cannot detect this failure; add a short-idle-timeout reconnect test with an event emitted after reconnection.

### [x] M4. SSE replay buffers the full history before emitting the first frame

**Resolution:** Replay uses effectful pagination and emits each page before requesting the next.

**Where:** `apps/bebop/src/api/event-stream.ts:58-78`

`drain` repeatedly reads pages into one array, advances the cursor, and only then creates a stream from the complete array. This defeats paging: subscriber memory and time-to-first-byte grow with the entire bounty history, and a history growing at least as quickly as it is read may prevent replay from ever finishing.

Use an effectful paginated/unfold stream that emits each page as it is pulled. Preserve the single cursor and concatenated replay/live phases, which are otherwise a good design.

### [x] M5. Startup reconciliation handles only the first 1,000 connections

**Resolution:** Reconciliation processes batches until no persisted live connection remains.

**Where:** `apps/bebop/src/api/server.ts:58-78`, `apps/bebop/src/persistence/swordfish.ts:178-184`

Reconciliation performs one bounded query and never loops. Rows after the first 1,000 retain dead connection IDs after API restart. Process batches until no connected projections remain; updated rows no longer match the query, so no offset is needed.

### [x] M6. The gateway's outer `catchCause` turns startup faults into empty success responses

**Resolution:** Only typed socket closure is absorbed; SQL failures and defects propagate through the consumer race.

**Where:** `apps/bebop/src/swordfish-gateway/gateway.ts:315-323`

The outer `catchCause` covers credential lookup, upgrade, all socket work, defects, and interruption. A database failure during token lookup or a programming defect is logged as an ordinary disconnect and converted to an empty response, potentially HTTP 200, instead of reaching HTTP error handling or supervision.

Catch expected clean socket closure/interruption at the narrow socket boundary. Propagate typed pre-upgrade failures and defects, and log them at error severity.

### [x] M7. Token creation reports every SQL failure as a duplicate name

**Resolution:** Only the token-name `UniqueViolation` maps to 422; other SQL errors remain internal failures.

**Where:** `apps/bebop/src/api/handlers.ts:233-249`

The handler catches every repository failure and returns `A token named ... already exists`. Connection loss, timeout, permissions, or schema failure are therefore misreported as a user error and will not be retried or diagnosed correctly.

Match only the named unique-constraint violation. Map all other SQL failures through the internal-error path.

## Test Review

### [x] T1. The restart test does not restart a worker or prove commands/projections survive

**Resolution:** Packed processes restart over one Postgres; component protocol tests verify persisted commands and projections.

**Where:** `apps/bebop/test/component/lifecycle.test.ts:128-150`, `apps/bebop/test/component/support/harness.ts:174-185`

The test named `restarting the API preserves bounties, tokens, and commands` restarts only the in-process HTTP layer. There is no worker process to restart, no command assertion, and no projection assertion. Jobs are manually run to exhaustion before restart.

Replace or supplement it with a process-level test that starts the packed API and worker as independent processes against one disposable database, terminates each at controlled boundaries, restarts them, and verifies the bounty, API token, command, projection cursor, and lifecycle job. This is also needed to prove packed migrations and signal shutdown rather than only source-module wiring.

### [x] T2. The SSE test does not prove its `every stored event` or history/live-race claim

**Resolution:** A strict SSE helper now validates transport and schema while a 206-event test crosses replay into live delivery.

**Where:** `apps/bebop/test/component/events.test.ts:36-74`, `apps/bebop/test/component/support/sse.ts:16-64`, `apps/bebop/src/api/event-stream.ts:26-100`

The test asks for exactly two frames and asserts `[1, 2]`; it never determines how many events are stored, crosses the 200-event page boundary, or appends while replay is draining. The live test calls broken `recover` only to obtain some next event.

The helper also converts timeout/abort into a partial successful result, returns an empty list for a bodyless response, ignores malformed blocks, and does not assert status or content type. Several tests use `length >= requested`, which can still pass after timeout with only the expected prefix.

Insert at least 205 known events, deliberately slow replay, append around the replay/live transition, and assert the complete exact cursor sequence once and in order. Make the helper fail unless it reaches the requested count with HTTP 200, `text/event-stream`, and schema-valid frames.

### [x] T3. Token tests exercise hashing trivia but not the security property

**Resolution:** HTTP tests cover bootstrap, creation, hash-only storage, listing, authentication, revocation, and duplicate names.

**Where:** `apps/bebop/test/persistence/tokens.test.ts:17-32`, `apps/bebop/test/component/api.test.ts:34-55`, `apps/bebop/test/component/support/harness.ts:152-163`

Asserting that a SHA-256 digest does not contain its input is not evidence that plaintext never reaches Postgres or a response that should omit it. There are no component tests for token creation, listing, duplicate names, revocation, immediate revocation enforcement, or authentication on the separately secured token route group.

Use the supported bootstrap path from H4, create a named token through HTTP, inspect Postgres to prove only its hash exists, authenticate with it, prove list contains metadata but no secret, revoke it, and require the very next request to return 401. Also assert every token route itself requires authentication.

### [x] T4. Failure, retry, interruption, and cancellation paths are effectively untested

**Resolution:** Injected failures cover retries, exhaustion, post-side-effect failure, lease recovery, and stop/destroy races.

**Where:** `apps/bebop/src/lifecycle/provider.ts:88-125`, `apps/bebop/src/worker/jobs.ts:114-159`, `apps/bebop/test/component/lifecycle.test.ts:44-150`

The fake provider cannot block or fail, so the suite cannot exercise failure before a side effect, failure after a side effect, worker interruption, retry delay, attempt exhaustion, destroy failure, or stop/destroy racing with provisioning. `PLAN.md` section 9 requires expected failure, restart, and cancellation behavior for milestone completion.

Add a controllable provider with barriers, fail-before, fail-after, and call-history modes. Assert retry timing, maximum attempts, final bounty status, no duplicate VM, no orphaned `running` job, and legal state under stop/destroy races.

### [x] T5. Gateway tests cover useful happy paths but omit the adversarial protocol boundaries

**Resolution:** Real WebSocket tests now cover ordering, VM binding, malformed and oversized frames, replay conflicts, and foreign results.

**Where:** `apps/bebop/test/component/gateway.test.ts:102-349`, `apps/bebop/src/swordfish-gateway/gateway.ts:137-313`

The duplicate-event and replaced-connection tests are valuable, but all stateful frames are sent sequentially with waits. Missing scenarios include concurrent consecutive events, heartbeat/event races, register replacement races, arbitrary VM registration, event before registration, conflicting duplicate sequence, malformed JSON, schema-invalid input, oversized frames and close code 1009, foreign command results, monotonic command results, and uncertain command delivery.

Add these as real WebSocket tests. For concurrency cases, use barriers in persistence rather than sleeps so the tests deterministically force the bad interleaving.

### [x] T6. Boundary-validation tests accept unrelated failures and do not check side effects

**Resolution:** Tests assert exact statuses, unchanged row counts, one durable create, and one provider operation.

**Where:** `apps/bebop/test/component/api.test.ts:88-102`, `apps/bebop/test/component/lifecycle.test.ts:78-89`

The invalid-create tests accept any 4xx response, so a 401, 404, 409, or handler-level 422 would pass even if contract decoding were bypassed. They do not verify that no bounty, idempotency key, event, or job was written. The concurrent-create test checks only one returned ID, not one bounty row, one job, one provider call, and no orphan rows.

Assert the exact typed bad-request response and database counts before/after invalid requests. Strengthen concurrent create to inspect every durable row and run the worker, proving one provider operation.

### [x] T7. The bounded-shutdown regression has no targeted test

**Resolution:** Gateway restart is timed while a WebSocket close handshake is in flight.

**Where:** `apps/bebop/src/runtime/shutdown.ts:24-46`, `apps/bebop/test/component/support/harness.ts:132-145`

Normal harness cleanup does not recreate the documented WebSocket close-handshake hang or assert the configured deadline. Removing `withBoundedShutdown` could leave the whole suite green.

Hold a WebSocket in the problematic close state, signal a real API process, and assert exit within `shutdownTimeout` plus a small tolerance. Verify committed state after restart.

## Validation Performed

- `vp install --frozen-lockfile`: passed.
- `vp run check`: passed.
- `BEBOP_TEST_DATABASE_URL=postgres://bebop:bebop@127.0.0.1:5433/bebop vp run ready`: passed.
- Unit and component tests: 35 files and 279 tests passed.
- Integration tests: 8 passed, including packed API/worker operation and restart over a disposable Postgres.
- Artifact smokes: all three Bebop artifacts and both Swordfish entrypoints passed.
