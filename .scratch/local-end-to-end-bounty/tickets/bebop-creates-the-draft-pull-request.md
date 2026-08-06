---
type: build
status: open
blocked-by: [github-app-permissions-and-ruleset-readback]
---

# Bebop creates and updates the draft pull request

Resolving this updates [Pull request and merge](../../../docs/capabilities/12-pull-request-and-merge.md).

## Background

Bebop has no GitHub integration at all: `apps/bebop/src/api/handlers.ts` refuses merge with _"merging requires
the GitHub integration, which this Bebop does not have yet"_, which is
[`ABSTRACT.md`](../../../ABSTRACT.md) §3.10 working as intended and also the gap this ticket closes. Pull-request
creation is bebop's under
[Bebop owns authority, Swordfish owns the loop (ADR 0002)](../../../docs/adr/0002-bebop-owns-authority-swordfish-owns-the-loop.md),
and stays bebop's on a laptop under
[The local loop runs the production assembly (ADR 0046)](../../../docs/adr/0046-the-local-loop-runs-the-production-assembly.md).

Merge itself is **not** in scope here: the local destination has the operator merging by hand on GitHub. What is
in scope is everything up to that — the draft PR, and the check polling that gates cowboy review under
[CI gates cowboy review (ADR 0040)](../../../docs/adr/0040-ci-gates-cowboy-review.md).

## Scope

- An app-local GitHub client service, not a multi-provider abstraction, holding App-installation authentication:
  the JWT-to-installation-token exchange, with expiry and refresh. Its layer is chosen at the entrypoint, since
  no core logic may branch on environment (ADR 0046).
- Create a draft pull request after the first pushed candidate, and update it on subsequent candidates. Draft
  from the start, so ordinary CI runs on creation and synchronisation.
- Poll required checks for the exact candidate SHA and report the result into the workflow, which already models
  the gate.
- Every response decoded at the seam, and durable intent written before the call, per the architectural rules.
- Structured logs carrying `bounty_id` and `candidate_sha` on every GitHub operation.

## Done when

- A local bounty that pushes a candidate ends up with a real draft pull request on the target repository,
  visible to the operator.
- A second candidate updates that pull request rather than opening another.
- CI failure for a candidate SHA returns feedback without activating jet; CI success lets review start.
- Success, GitHub refusal, rate limiting, and restart mid-operation are all tested, and a restart does not
  create a duplicate pull request.
- `vp run ready` passes.
