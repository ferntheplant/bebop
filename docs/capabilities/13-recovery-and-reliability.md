# Recovery and reliability

What happens when something breaks — a process restarts, a network partitions, a VM disappears. The promise is
narrow and worth stating plainly: restarting anything must not duplicate a VM, a prompt, a pull request, or a
merge.

## What you can expect

- **Work continues while bebop is unreachable.** Implementation, validation, review, and QA keep running inside
  the bounty. Only operations needing bebop's authority — PR creation, CI observation, evidence publication,
  merge, destruction — wait for reconnection.
- **Nothing happens twice.** Both sides write durable intent before performing an externally visible side effect,
  and every at-least-once message carries a stable ID or sequence number so replay is safe.
- **A restart resumes rather than guesses.** Swordfish reloads its database, inspects worktrees and processes,
  queries the OpenCode server, reconciles seat status, replays unsent events, and resumes only once it can prove
  the current stage. It will not re-send a prompt merely because it cannot tell whether the last one completed.
- **Startup fails closed.** Uncertain local state — integrity checks, outbox completeness, child PIDs, recorded
  worktree paths — is inspected before work resumes, and an interrupted external operation is never assumed to
  have completed.
- **Disconnection is visible, not disguised.** Bebop's projection records freshness, so a bounty whose Swordfish
  is gone is never shown as still working.
- **A client can follow everything without polling**, and a dropped subscriber reconnects with a cursor and
  misses nothing.
- **A lost VM is not a lost bounty.** Bebop can build a replacement from the assigned branch and the master-side
  effective spec; the bounty identity, branch, and artifacts survive. Continuing the lost model context is
  explicitly not promised.
- **Constraint exhaustion parks work, not the VM.** Swordfish quiesces the final attempt and stops its watchdogs,
  but the VM, repository services, cockpit, and durable seat state remain immediately inspectable. Status shows
  the attention age, complete scoped ledger, last outcome, and only valid recovery commands.
- **Nightly off-VM backups**, with failure alerts and a monthly sampled restore test.

## Where it stands

**Partial.** This is the most-built capability. Both processes reconnect, replay, deduplicate, and reconcile;
sequence gaps, conflicting replays, and stale-connection traffic are all rejected with reasons. What has never
happened is the two of them running as separate processes across a network that can actually break.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **29** (constraint exhaustion enters `needs_attention`),
**30** (a human explicitly continues the final attempt or reruns fresh work without resetting unrelated
allowances), **40** (a client can follow the whole flow over SSE without polling), and **42** (restarting
Swordfish or bebop does not duplicate VMs, prompts, PRs, or merges).

## Decisions

- [Replay fails closed (ADR 0029)](../adr/0029-replay-fails-closed.md) — a conflicting replay fails rather than
  silently overwriting, and every no-op carries a reason because the acknowledgement decision depends on which
  kind it was.
- [Swordfish's authority is locked to its database (ADR 0027)](../adr/0027-swordfish-authority-is-locked-to-its-database.md)
  — the control socket cannot protect SQLite, so the lock lives beside the database and the database is
  identity-bound.
- [Postgres for bebop, SQLite for Swordfish (ADR 0008)](../adr/0008-postgres-for-bebop-sqlite-for-swordfish.md)
  — durable truth that should die with the VM it describes.
- [The bounty primitive (ADR 0001)](../adr/0001-the-bounty-primitive.md) — why a replacement VM is possible at
  all.
- [The master runs on exe.dev (ADR 0019)](../adr/0019-the-master-runs-on-exe-dev-with-mandatory-off-vm-backups.md)
- [Continue preserves an attempt; rerun replaces it (ADR 0041)](../adr/0041-continue-preserves-an-attempt-rerun-replaces-it.md)

Bounded shutdown behaviour and the connection-lifetime constraints behind it are in
[`docs/gotchas.md`](../gotchas.md#process-lifecycle).

## Still open

- [Should the scheduled Effect loops be virtualized with `TestClock`?](../../.scratch/bebop-mvp/issues/15-testclock-for-the-scheduled-loops.md)
- [What happens when bebop declares a bounty's runtime manifest defective?](../../.scratch/bebop-mvp/issues/19-runtime-manifest-defect-recovery.md)
- **The end-to-end protocol under real failure** and **release qualification** — both still fog on
  [the map](../../.scratch/bebop-mvp/map.md).
