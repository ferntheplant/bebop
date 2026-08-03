# The effective-spec handoff

The moment a bounty stops being a conversation and becomes autonomous work. You talk to ein until the task is
clear, then `/auto` distils what you agreed into an **effective spec**, shows it to you, and does not proceed
until you confirm it. Nothing autonomous starts without one.

## What you can expect

- **An ordinary conversation first.** Ein's seat is live from the moment the bounty exists; you refine the task
  in its pane the way you would with any local agent.
- **`/auto` writes the spec, you approve it.** Ein summarises the effective task, produces a structured spec,
  shows it, and revises until you confirm. It must declare at least one acceptance criterion, because every gate
  downstream assesses the work against them.
- **Confirmation is a single atomic act.** `set_spec` persists the revision, records your confirmation, transfers
  ein's control lease to Swordfish, revokes any seat credential you were issued, and enters implementation —
  together or not at all.
- **It never starts without a spec.** If ein goes idle without calling `set_spec`, Swordfish re-prompts once;
  repeated failure leaves the bounty interactive and marks it as needing attention rather than guessing.
- **The spec is versioned.** Later revisions carry a new number, and gate results are bound to the revision that
  was current when they ran.
- **Handing back can revise it.** After a takeover, you explicitly declare whether the conversation changed the
  effective spec. An unchanged spec resumes only after reconciliation; a changed spec keeps human control until
  you confirm a new revision through `set_spec`.

## Where it stands

**Designed.** The spec revision is modelled in the shared workflow core and Swordfish persists it, but `/auto`,
`set_spec`, and the plugin that would host them do not exist — the bebop OpenCode plugin is currently a stub. The
biggest open area is not the mechanism but what ein is actually told: prompt construction, spec restatement after
compaction, and how stage feedback is presented are all unresolved, and probably the single largest determinant
of whether the loop works.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **8** (the user discusses a task interactively), **9**
(`/auto` produces a structured effective spec), **10** (the user confirms it), and **11** (`set_spec` transfers
control to Swordfish).

## Decisions

- [Commit to OpenCode (ADR 0004)](../adr/0004-commit-to-opencode-with-no-harness-abstraction.md) — the plugin is
  a first-class module, not an integration behind an abstraction.
- [Seat credentials die with the lease (ADR 0010)](../adr/0010-no-human-held-seat-credential-survives-a-control-release.md)
  — why `set_spec` revokes as part of the same transition.
- [Every commit invalidates every downstream result (ADR 0016)](../adr/0016-every-commit-invalidates-every-downstream-result.md)
  — gate results are bound to the spec revision as well as the SHA.
- [Control passes through a quiescent handoff (ADR 0036)](../adr/0036-control-passes-through-a-quiescent-handoff.md)
  — why the human declares whether handback resumes or revises the effective spec.

## Still open

- **What ein is actually told** — still fog on [the map](../../.scratch/bebop-mvp/map.md) rather than a ticket,
  because the question is not yet sharp enough to state.
