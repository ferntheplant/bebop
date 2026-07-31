# Autonomous implementation and revision

The loop the whole product exists to run. Swordfish drives ein's seat, ein implements and submits candidates,
gates return findings, and ein revises — keeping its conversational and implementation context the entire time,
which is the thing a fresh-context agent cannot do.

## What you can expect

- **Swordfish drives, deterministically.** The workflow state machine is software, not a model. No context window
  is the authoritative record of where a bounty is.
- **Ein keeps its context.** Findings from review, CI, and QA come back to the same seat that wrote the code, so
  revision is a continuation rather than a re-explanation.
- **An explicit completion protocol.** Ein reports `candidate_ready`, `blocked`, or `continue`. A seat that falls
  idle without reporting is re-prompted once; repeated failure becomes `needs_attention` rather than a hang.
- **Only a real submission counts.** A candidate is tied to exactly one commit SHA, and a harness going quiet is
  not a candidate. Swordfish checks the commit exists, is reachable, carries the current spec revision, and left
  nothing relevant uncommitted.
- **Findings arrive aggregated.** One feedback packet per round rather than a drip of individual complaints.
- **A gate that produced nothing says so.** "Jet found nothing" and "jet did not answer" are different values,
  and the second is a detectable error with a reason attached.
- **Every new commit restarts the pipeline.** Local validation, CI, review, QA, readiness, and commit-bound
  evidence all die with the commit they described.
- **Compaction cannot lose the thread.** Durable workflow truth — spec revisions, candidates, feedback packets —
  lives in Swordfish's database rather than in a context window, and Swordfish restates the effective spec and
  the current stage in every autonomous prompt. A seat that compacts mid-bounty picks up where it was without
  any extra checkpointing.

## Where it stands

**Partial.** The pure transition core is real, shared between bebop's projection and Swordfish's reducer, and
tested separately from persistence and I/O — one module rather than two drifting copies. Swordfish persists
stages, candidates, and its constraint ledger over SQLite. What does not exist is everything touching OpenCode:
prompting a seat, observing its event stream, idle detection, and the plugin's workflow signals.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **14** (Swordfish can prompt and observe OpenCode through its
server API), **15** (an idle seat without a workflow signal is re-prompted once), **16** (ein submits a candidate
commit), **23** (a blocking CI or review result returns to ein's seat), **24** (a new commit invalidates all
previous results), and **28** (a QA failure returns to ein and restarts the full pipeline).

## Decisions

- [Commit to OpenCode (ADR 0004)](../adr/0004-commit-to-opencode-with-no-harness-abstraction.md) — the server API
  and SSE stream are the automation seam; PTY keystroke injection is not.
- [Every commit invalidates every downstream result (ADR 0016)](../adr/0016-every-commit-invalidates-every-downstream-result.md)
  — revision loops are expensive by construction, and that is the intended pressure.
- [Flaky gates are not auto-retried (ADR 0031)](../adr/0031-flaky-gates-are-not-auto-retried.md) — a human
  extends the exhausted constraint, because hiding flakiness is what the ledger exists to prevent.
- [Code moves to a package on its second consumer (ADR 0007)](../adr/0007-code-moves-to-a-package-on-its-second-consumer.md)
  — why the transition core is shared rather than written twice.

## Still open

- [Which model does each seat run, and what happens when it can't be reached?](../../.scratch/bebop-mvp/issues/05-seat-models-and-provider-failure.md)
- [What are the default constraints, and what happens when one is exhausted?](../../.scratch/bebop-mvp/issues/09-default-constraints-and-exhaustion.md)
- **What ein is actually told** — fog on [the map](../../.scratch/bebop-mvp/map.md), and probably the single
  biggest determinant of whether this loop works at all.
