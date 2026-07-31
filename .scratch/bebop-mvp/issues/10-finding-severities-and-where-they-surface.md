# Which findings block, and where do the ones that don't block surface?

Type: grilling
Status: open

## Question

Only `blocking` blocks, and non-blocking findings are provisionally destined for the evidence bundle plus a PR
comment at ready time ([ADR 0016](../../../docs/adr/0016-every-commit-invalidates-every-downstream-result.md),
`docs/design/SYSTEM.md` §12.6).

Settle:

- the severity vocabulary jet and faye are instructed to use, and how an agent is kept from grading everything
  `blocking` — or from grading nothing;
- whether a large pile of non-blocking findings should itself block, and what "large" means;
- where a non-blocking finding goes if the bounty is never merged;
- whether the human reviewing the PR can promote a finding to blocking without a new commit, and what that does
  to the readiness claim;
- how findings are addressed back to ein: as prose, as structured items it must respond to individually, or as
  a checklist it can close — this decides whether "the agent found nothing" and "the agent ignored it" stay
  distinguishable.
