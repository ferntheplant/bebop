# What breaks when real Bebop and Swordfish processes run together locally?

Type: prototype
Status: open

## Question

Bebop and Swordfish each have real packed entrypoints, durable persistence, reconnect logic, and component tests
against a fake peer. They have never been launched together as separate processes: gateway tests fake Swordfish,
and protocol tests fake Bebop. Run that seam over loopback with real Postgres and SQLite, the existing fake
lifecycle provider, and no VM or exe.dev subscription.

Establish:

- how a local operator obtains the retry-stable Swordfish credential that the fake lifecycle provider would
  inject into a VM, without adding a second credential path;
- which startup order, listener loss, daemon loss, and process restart cases preserve registration, event replay,
  command delivery, acknowledgement, and projection without duplication;
- whether the packed Bebop API, worker, CLI, Swordfish daemon, and `sf` CLI compose without test-only workflow
  injection;
- the furthest honest workflow progression the current production paths can reach. Today that is expected to be
  `interactive`, reconnection, durable `stop`, and cancellation: no production module yet drives OpenCode or
  emits the attempt, candidate, and gate events used by reducer tests;
- which failures require a protocol decision or ADR, and which only require implementation or regression tests.

Keep the probe hermetic and subscription-free. Do not add a local compute provider, `sf inject`, a test-only
event endpoint, OpenCode prompting, repository hooks, GitHub, or claims that the autonomous loop runs locally.
Resolve with the observed failures and a brief for the smallest production-quality local system harness that the
probe justifies.
