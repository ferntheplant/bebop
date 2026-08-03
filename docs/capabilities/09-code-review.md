# Code review

An independent reviewer that has never seen the conversation. Jet gets the spec, the diff, and read-only tools —
and nothing of ein's reasoning about why the code looks the way it does. Its independence comes from context
isolation and restricted tooling, not from using a different vendor's model.

## What you can expect

- **A fresh seat for every attempt.** Jet cannot see ein's conversation or a prior review attempt, so it cannot
  inherit either one's assumptions about what the code is supposed to be doing.
- **Read-only by construction.** Jet has repository read access, diff access, validator and CI output, and web
  research tools. It cannot edit the repository, and it does not get ein's production-context MCPs.
- **Review runs in parallel with external CI**, both against the exact candidate SHA, after local validation
  passes.
- **Structured findings**, each with a severity, a title, a description, evidence, and optionally a file, a line,
  and a suggested direction.
- **Only blocking findings stop a candidate.** Non-blocking findings ride along in the evidence bundle rather
  than forcing a revision round.
- **A silent reviewer is an error, not an approval.** A stage that produced prose instead of findings, or output
  that does not decode, records that explicitly with a reason.

## Where it stands

**Designed.** Jet's seat, the review prompt, and the findings pipeline do not exist. External CI observation
depends on GitHub, which bebop does not have yet.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criterion **22** (external CI, observed by polling, and jet's
read-only review both run).

## Decisions

- [Swordfish connects outbound only (ADR 0013)](../adr/0013-swordfish-connects-outbound-only.md) — why CI is
  observed by polling rather than by webhook.
- [Every commit invalidates every downstream result (ADR 0016)](../adr/0016-every-commit-invalidates-every-downstream-result.md)
  — a review is a statement about one commit and dies with it.
- [The VM is the sandbox (ADR 0012)](../adr/0012-the-vm-is-the-sandbox.md) — jet's read-only profile is set at
  seat creation so permission prompts cannot occur.

Cross-vendor frontier review for jet is out of scope for this effort; see [the
map](../../.scratch/bebop-mvp/map.md).

## Still open

- [Which findings block, and where do the ones that don't block surface?](../../.scratch/bebop-mvp/issues/10-finding-severities-and-where-they-surface.md)
- [Which model does each seat run, and what happens when it can't be reached?](../../.scratch/bebop-mvp/issues/05-seat-models-and-provider-failure.md)
