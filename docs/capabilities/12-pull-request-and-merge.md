# Pull request and merge

How a bounty's work reaches your target branch, and the one act that finishes it. Bebop holds merge authority
outside the sandbox and never uses it without an explicit human command — **catching the bounty** is always your
decision.

## What you can expect

- **A real pull request, early.** Bebop creates a draft PR after the first pushed diff, so your normal CI runs on
  draft creation and synchronisation rather than waiting for the PR to be marked ready.
- **Normal Git inside the VM.** Agents push with ordinary Git commands through a repository-scoped integration;
  the reusable GitHub credential never lands on the machine.
- **Readiness is re-verified, never trusted.** Swordfish may claim a commit is ready; before offering merge,
  bebop independently checks that the branch still points at that commit, that required checks passed for it,
  that the required stages passed for it, that the spec revision matches, and that no privileged-path change is
  unapproved.
- **Readiness can be lost without anything happening.** A push after readiness silently removes it, because the
  check runs against live state rather than against a stored flag.
- **Squash-only merges.** One bounty is one reviewable commit on the target branch, and reverting is one commit.
- **Honest authorship.** Commits are authored by the acting seat and pushed by the integration's App identity.
  Your personal GitHub identity never appears as author or committer — which is also why the exe.dev Git
  integration must not be configured with `--act-as-user`. That flag would make pushes look conventional at the
  cost of attributing agent-written code to a human who never wrote it.
- **Base drift handled without churn.** Status shows "behind base by N"; results are invalidated only if the PR
  actually becomes unmergeable, in which case ein merges base back in.
- **The sandbox cannot reach your protected branch.** The only path to the merge target is an explicit merge
  command through bebop.

## Where it stands

**Refuses honestly.** The merge route exists and returns a refusal — _"merging requires the GitHub integration,
which this Bebop does not have yet"_ — rather than a plausible success. Nothing about branches, pushes, draft
PRs, CI polling, or merging is built.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **20** (the candidate is pushed with normal Git), **21**
(bebop creates or updates a draft PR), **35** (`bounty list` shows ready only for the verified head SHA), **36**
(a push after readiness removes ready status), **37** (base drift drops the bounty to revision and ein merges
base back in), **38** (the sandbox cannot update the protected merge target), and **39** (only an explicit bebop
merge command squash-merges the PR).

## Decisions

- [Readiness is a claim, not authority (ADR 0003)](../adr/0003-readiness-is-a-claim-not-authority.md) — the rule
  that makes the whole sandbox model hold.
- [Squash-only merges (ADR 0017)](../adr/0017-squash-only-merges.md)
- [Commits are authored by the acting seat (ADR 0032)](../adr/0032-commits-are-authored-by-the-acting-seat.md)
- [Base drift invalidates only on conflict (ADR 0033)](../adr/0033-base-drift-is-conflict-gated.md)
- [Swordfish connects outbound only (ADR 0013)](../adr/0013-swordfish-connects-outbound-only.md) — why CI is
  polled rather than pushed to bebop.

A compromised sandbox can modify unprotected refs in its allowed repository; that is accepted, and branch
protection on the merge target is the mitigation.

## Still open

- [What GitHub App permissions are actually needed, and how is the target branch protected?](../../.scratch/bebop-mvp/issues/12-github-app-permissions-and-branch-protection.md)
