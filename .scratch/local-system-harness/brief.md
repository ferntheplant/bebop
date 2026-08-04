# Brief: a production-quality local system harness

Turn the real-process result from
[ticket 20](../bebop-mvp/issues/20-real-process-local-protocol.md) into a maintained, one-command local harness.
The harness runs packed Bebop API, worker, and CLI processes plus packed Swordfish daemon and `sf` processes over
loopback with disposable Postgres and SQLite. It provides the process floor on which the production OpenCode
driver can prove autonomous state tracking before exe.dev provisioning exists.

Source prototype: [`prototypes/real-process-local-protocol`](../../prototypes/real-process-local-protocol/README.md).

## Why now

The prototype proved that the real protocol peers preserve registration, replay, command deduplication,
acknowledgement, and projection across listener and daemon loss. Keeping the throwaway driver as the only proof
would let those properties regress while the OpenCode driver is built. Moving directly to the driver without a
maintained local process harness would also force every workflow test to solve process startup, bootstrap
credentials, readiness, logs, and teardown independently.

The harness is not a local compute provider and does not claim to emulate exe.dev. It is a local system runner for
the packed software that already exists.

## Scope

### Lifecycle bootstrap

- Add an explicitly local option to the existing fake lifecycle provider that writes a one-shot bootstrap
  artifact beneath a configured scratch root.
- The worker passes the same retry-stable token it already gives `LifecycleProvider.provision`; no API, CLI, or
  second derivation returns the token.
- Write atomically into a mode-`0700` directory with a mode-`0600` file. Include only bounty ID, VM ID, and the
  redacted-at-every-log machine credential needed to start Swordfish.
- Repeated provisioning for one bounty rewrites the same artifact with the same identity and credential. The
  harness consumes and removes it only after Swordfish has started.
- Keep this behavior disabled unless the local harness root is configured. Production fake-provider behavior
  otherwise remains unchanged.

### Process supervisor

- Provide one repository task that builds and runs the packed API, worker, Bebop CLI, Swordfish daemon, and `sf`
  CLI with disposable Postgres and per-bounty SQLite/socket/artifact roots.
- Use public HTTP, WebSocket, CLI, and Unix-socket interfaces. The supervisor must not import source from either
  app or mutate either database directly.
- Capture each process's structured output separately and surface bounty ID, VM ID, stage, cursor, and command ID
  in failure reports.
- Allocate loopback ports dynamically. Tear down old scratch state before startup and clean processes,
  containers, sockets, databases, and artifact roots after success and failure.
- Bound every readiness wait and every shutdown. A failed child or missed deadline fails the task instead of
  leaving a partial local fleet running.

### CLI alignment required by the scenarios

- Add the existing Bebop stop HTTP operation to the thin packed CLI; the harness must not need a private HTTP
  escape hatch for its stop scenario.
- Replace local `sf stop` with authenticated `sf cancel`: it records `cancelling` and `cancelled`, keeps the
  daemon alive, and lets the normal protocol loop deliver both events.
- Keep Bebop stop as the external-authority command that requests daemon shutdown after its terminal command
  result is sent.
- Update capability status text and CLI help to match this shipped slice. The remaining missing thin adapters are
  separate work.

### Maintained scenarios

- worker before API and API before worker both migrate and reach health;
- create retry with one idempotency key yields one bounty, VM mapping, and bootstrap identity;
- Swordfish before listener reaches local `interactive`, then registers and drains one event;
- API restart restores the acknowledged cursor and produces no duplicate public event;
- daemon `SIGKILL` and restart from the same SQLite restores the cursor and projection;
- local `sf cancel` projects `cancelled` while the daemon remains available;
- a Bebop stop queued while Swordfish is offline is delivered once, reports a terminal result, and does not stop
  the following daemon restart;
- every success and failure path leaves no live child, socket, database, container, or plaintext bootstrap
  artifact.

## Not in scope

- exe.dev provisioning, a local VM abstraction, SSH/cockpit emulation, GitHub, real repositories, or paid models;
- test-only workflow event injection or direct writes to Postgres/SQLite;
- OpenCode prompting, event observation, idle recovery, candidate submission, or gate execution;
- resolving the SSE keepalive decision in ticket 18;
- a generic process, compute-provider, or harness abstraction.

The next slice consumes this harness by adding OpenCode directly to Swordfish, using the repository's scripted
fake model endpoint. OpenCode events must enter through the production driver and plugin workflow actions, not a
harness shortcut.

## Done when

- one documented `vp run` task starts the full local system and exits nonzero on a failed scenario;
- the machine credential travels only from Bebop derivation through `LifecycleProvider.provision` to the local
  bootstrap artifact and Swordfish process, never through an operator retrieval route;
- all maintained scenarios above pass repeatedly from a clean checkout;
- cancellation reaches Bebop without restarting Swordfish, and `sf status` remains available afterward;
- the offline stop command is terminal and replay-safe across two daemon restarts;
- no child process, Docker resource, socket, database, or plaintext credential remains after success,
  assertion failure, signal, or startup failure;
- the suite runs without exe.dev, GitHub, or a paid model;
- `vp run ready` passes with Postgres-backed suites enabled.
