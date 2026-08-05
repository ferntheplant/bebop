# Fallow cleanup

Label: `wayfinder:map`

## Destination

Fallow reports zero findings under a committed policy — dead code, duplication, and health — and
`fallow audit` runs as a PR gate in CI. Repo clean first, then PR clean, per the
[Fallow adoption guide](https://docs.fallow.tools/adoption).

## Notes

**Domain:** tooling hygiene, not bebop product code. The adoption guide fixes both the order of work — repo
clean, then PR clean — and the mechanisms: config modeling over suppression, narrow exceptions over broad ones.
Every finding resolves one of four ways: fix in code, model in config, a narrow inline suppression, or a
consciously widened threshold with written justification.

**This effort carries execution, not just decisions.** "Plan, don't do" is overridden: cleanup is the work,
and the map is done when the repo is clean and auditable, not when the plan is agreed.

**Skills:** `/research` when the Fallow docs or the knip migration matter; `/grilling` when a finding's
disposition is a genuine tradeoff. Groundwork already settled lives in the ADRs — prototypes handling is
[Fallow treats prototype drivers as entry points (ADR 0044)](../../docs/adr/0044-fallow-treats-prototype-drivers-as-entry-points.md)
and [Prototype duplication is expected (ADR 0045)](../../docs/adr/0045-prototype-duplication-is-expected.md) —
and in `.fallowrc.json`, which models the prototype drivers, smoke scripts, and spawned test fixture as entry
points.

## Decisions so far

<!-- one line per closed ticket, once tickets resolve -->

## Not yet specified

- Health hotspots, led by `changesFor` at cyclomatic 113 / cognitive 155 in `packages/workflow/src/core.ts`:
  refactor it, or consciously widen the threshold with written justification. Unblocked — the dead-code backlog
  is clear, so the health signal is no longer distorted by dead exports.
- [How does `fallow audit` enter CI?](./issues/how-fallow-audit-enters-ci.md) — now a ticket. Dead-code
  repo-clean cleared the guide's stage-1 bar, so the gate no longer waits on the backlog; what is open is which
  rollout shape it takes and how much of the analysis surface it carries.
- Duplication below the prototype exemptions: whether `fallow dupes --mode semantic` finds anything worth
  consolidating once the testkit spawn-and-collect promotion lands.

## Out of scope

- Re-litigating the prototype entry and duplication exemptions — settled by ADRs 0044 and 0045.
