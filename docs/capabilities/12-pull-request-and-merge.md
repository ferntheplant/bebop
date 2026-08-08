# Pull request and merge

How a bounty's work reaches your target branch, and the one act that finishes it. Bebop holds merge authority
outside the sandbox and never uses it without an explicit human command — **catching the bounty** is always your
decision.

## What you can expect

- **A real pull request, early.** Bebop creates a draft PR after the first pushed diff, so your normal CI runs on
  draft creation and synchronisation rather than waiting for the PR to be marked ready.
- **CI before cowboy review.** Bebop polls required checks for the exact candidate SHA. A clean failure returns
  feedback to ein without activating jet; only a CI-passed SHA consumes a validated-candidate slot and enters
  independent review.
- **Normal Git inside the VM.** Agents push with ordinary Git commands through a repository-scoped integration;
  the reusable GitHub credential never lands on the machine.
- **Swordfish owns the candidate reaching GitHub.** An agent may push whenever it likes and is never load-bearing
  for it. When ein submits a candidate, Swordfish confirms the working tree is clean and then pushes that SHA
  itself — a no-op when the agent already pushed it, and one code path that runs on every candidate rather than
  only when an agent misbehaves. A dirty tree is refused back to ein without consuming a validated-candidate
  slot, because that allowance is charged when CI approves rather than at submission.
- **Readiness is re-verified, never trusted.** Swordfish may claim a commit is ready; before offering merge,
  bebop independently checks that the branch still points at that commit, that required checks passed for it,
  that the required gates approved it, that the spec revision matches, and that no privileged-path change is
  unapproved.
- **Readiness can be lost without anything happening.** A push after readiness silently removes it, because the
  check runs against live state rather than against a stored flag.
- **Squash-only merges.** One bounty is one reviewable commit on the target branch, and reverting is one commit.
- **Honest authorship.** Every commit is authored by one machine identity, `bebop`, with the acting seat and the
  bounty in commit-message trailers. Your personal GitHub identity never appears as author or committer, and
  that holds on a bounty you steered heavily through takeover — you supplied intent, not code. It is also why
  the exe.dev Git integration must not be configured with `--act-as-user`. That flag would make pushes look
  conventional at the cost of attributing cowboy-written code to a human who never wrote it.
- **Base drift handled without churn.** Status shows "behind base by N"; results are invalidated only if the PR
  actually becomes unmergeable, in which case ein merges base back in.
- **The sandbox cannot reach your protected branch.** The only path to the merge target is an explicit merge
  command through bebop.
- **Your target repository has to be one GitHub will protect.** Bebop checks, before it offers a merge, that
  branch rules are actually in effect on the target — and refuses if they are not. GitHub enforces rulesets on
  public repositories on every plan, but on private repositories only from Pro, Team, or Enterprise upward. A
  private repository on a free plan cannot be a merge target until it is upgraded or made public; bebop will say
  so, and say which plan is needed, rather than merging into an unprotected branch.
- **Nobody hand-pushes to the target, including you.** The rule that stops the sandbox has no administrator
  exemption. Landing something on the merge target without a pull request means removing the rule first.

## Where it stands

**Refuses honestly.** The merge route exists and returns a refusal — _"merging requires the GitHub integration,
which this Bebop does not have yet"_ — rather than a plausible success. Nothing about branches, pushes, draft
PRs, CI polling, or merging is built.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **20** (the candidate is pushed with normal Git), **21**
(bebop creates or updates a draft PR), **35** (`bounty list` shows ready only for the verified head SHA), **36**
(a push after readiness removes ready status), **37** (conflicting base drift returns the bounty to `building`
with feedback so ein merges base back in), **38** (the sandbox cannot update the protected merge target), and
**39** (only an explicit bebop merge command squash-merges the PR).

## Decisions

- [Readiness is a claim, not authority (ADR 0003)](../adr/0003-readiness-is-a-claim-not-authority.md) — the rule
  that makes the whole sandbox model hold.
- [Squash-only merges (ADR 0017)](../adr/0017-squash-only-merges.md)
- [Commits carry one machine identity (ADR 0047)](../adr/0047-commits-carry-one-machine-identity.md) — one author
  for every seat and for takeover, with provenance in trailers.
- [Base drift invalidates only on conflict (ADR 0033)](../adr/0033-base-drift-is-conflict-gated.md)
- [Swordfish connects outbound only (ADR 0013)](../adr/0013-swordfish-connects-outbound-only.md) — why CI is
  polled rather than pushed to bebop.
- [The merge target must enforce rulesets (ADR 0034)](../adr/0034-the-merge-target-must-enforce-rulesets.md) —
  why the target repository's plan and visibility are Bebop's business.
- [CI gates cowboy review (ADR 0040)](../adr/0040-ci-gates-cowboy-review.md) — why CI latency is paid before
  independent model turns.
- [The local loop runs the production assembly (ADR 0046)](../adr/0046-the-local-loop-runs-the-production-assembly.md)
  — why bebop creates the pull request even on a laptop, and which GitHub identity does what there.

A compromised sandbox can modify unprotected refs in its allowed repository; that is accepted, and the ruleset
on the merge target is the mitigation. It is the _only_ mitigation: an installation token cannot be scoped to
`bounty/*`, and merging needs the same `contents: write` the sandbox pushes with, so the two identities cannot
be separated by permission alone.

Bebop posts the evidence comment under `pull_requests: write`, without holding `issues: write` — what its App is
granted and why is in [the security model](./14-the-security-model.md).

## Still open

- Can the machine's repository-scoped integration push a candidate that changes `.github/workflows/**`? GitHub
  requires a second permission for a ref that touches a workflow file, over and above the write access an
  ordinary push needs. This is the machine's credential rather than bebop's App, and the local loop cannot
  answer it: an operator's ambient token usually already carries the scope, so the first refusal would appear
  in production. The failure is a candidate that cannot reach GitHub at all, for a reason unrelated to the
  quality of its diff — so what it looks like, and what ein is told, both need establishing.
