# The effective-spec handoff

The moment a bounty stops being a conversation and becomes autonomous work. You talk to ein until the task is
clear, then `/set-spec` distils what you agreed into an **effective spec**, shows it to you, and does not proceed
until you confirm it. The stage becomes `building` under human control; `/handoff` separately gives control to
Swordfish. Nothing autonomous starts without both actions.

## What you can expect

- **An ordinary conversation first.** Ein's seat is live from the moment the bounty exists; you refine the task
  in its pane the way you would with any local cowboy.
- **`/set-spec` writes the spec, you approve it.** Ein summarises the effective task, produces a structured spec,
  shows it, and revises until you confirm. It must declare at least one acceptance criterion, because every gate
  downstream assesses the work against them.
- **Confirmation changes work, not control.** `set-spec` persists the revision, records your confirmation,
  invalidates any previous candidate and gates, and enters `building`. Human control follows that transition.
- **Handoff is separate and explicit.** `/handoff` releases control without changing stage; Swordfish then starts
  a fresh ein operation in `building`.
- **It never builds without a spec.** `candidate-ready` and every later action are invalid until a confirmed spec
  revision exists.
- **The spec is versioned.** Later revisions carry a new number, and gate results are bound to the revision that
  was current when they ran.
- **Any live stage can reopen it.** Outside `cancelling`, `cancelled`, and `failed`, `reopen-spec` invalidates the
  current candidate and gates, returns to `creating_spec`, and activates ein's durable seat. Cowboy invocation
  preserves Swordfish control. A human first takes over when a cowboy is active; from a deterministic stage with
  no cowboy, authenticated `reopen-spec` establishes human control directly. Human control then lasts until
  handoff.

## Where it stands

**Designed.** The spec revision is modelled in the shared workflow core and Swordfish persists it, but
`/set-spec`, `/handoff`, and the plugin that would host them do not exist — the bebop OpenCode plugin is currently a stub. The
biggest open area is not the mechanism but what ein is actually told: prompt construction, spec restatement after
compaction, and how stage feedback is presented are all unresolved, and probably the single largest determinant
of whether the loop works.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **8** (the user discusses a task interactively), **9**
(`/set-spec` produces a structured effective spec), **10** (the user confirms it), and **11** (`/handoff`
transfers control to Swordfish).

## Decisions

- [Commit to OpenCode (ADR 0004)](../adr/0004-commit-to-opencode-with-no-harness-abstraction.md) — the plugin is
  a first-class module, not an integration behind an abstraction.
- [Seat credentials die with the lease (ADR 0010)](../adr/0010-no-human-held-seat-credential-survives-a-control-release.md)
  — why a later handoff revokes any credential issued during human control.
- [Every commit invalidates every downstream result (ADR 0016)](../adr/0016-every-commit-invalidates-every-downstream-result.md)
  — gate results are bound to the spec revision as well as the SHA.
- [Control passes through a quiescent handoff (ADR 0036)](../adr/0036-control-passes-through-a-quiescent-handoff.md)
  — why human access is revoked before control returns.
- [One controller drives one active cowboy (ADR 0037)](../adr/0037-one-controller-drives-one-active-cowboy.md)
  — why spec transitions and control transfer are separate.

## Still open

- **What ein is actually told** — still fog on [the map](../../.scratch/bebop-mvp/map.md) rather than a ticket,
  because the question is not yet sharp enough to state.
