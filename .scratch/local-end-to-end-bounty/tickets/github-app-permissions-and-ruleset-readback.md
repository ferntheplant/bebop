---
type: research
status: open
blocked-by: [provision-github-app-for-local-bebop]
---

# What GitHub App permissions does bebop actually need?

Resolving this updates [The security model](../../../docs/capabilities/14-the-security-model.md), [Pull request and merge](../../../docs/capabilities/12-pull-request-and-merge.md).

## Question

[The security model](../../../docs/capabilities/14-the-security-model.md) has carried this as an open question
without an owner: what permissions bebop's App actually needs, and how the target branch is protected. It is
answerable now, against a live installation, and it gates the pull-request work.

Nothing has established the set yet.
[The merge target must enforce rulesets (ADR 0034)](../../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md)
makes exactly one permission claim — merging a pull request needs `contents: write`, the same permission the
sandbox already pushes with, which is why the two identities cannot be separated by permission and the ruleset
is the only mitigation. Everything else is unestablished.

It has to be settled by probing rather than by reading. ADR 0034's findings were reached by driving a live
repository precisely because several contradicted what the documentation implied — that a ruleset denies the
repository owner, that merging through the pull-request API satisfies a `pull_request` rule, that the
plan-not-supported case is distinguishable from the no-rules-configured case. Expect the same here.

Establish, against the live App:

- the minimum permission set for each thing bebop does — create and update a draft pull request, read check runs
  for an exact SHA, read back effective branch rules, post the evidence comment, and squash-merge through the
  pull-request API — and which of those are `contents`, `pull_requests`, `checks`, `issues`, or
  `administration`;
- what the ruleset verification call returns in each of its three states, and whether `allowed_merge_methods`
  reads back the way ADR 0034 records;
- what an under-permissioned call fails with, so bebop can tell "the App lacks a permission" from "the
  repository refused" and say which;
- whether any of it needs `administration`, which would be worth knowing before granting it — an App that can
  reconfigure rulesets can remove the protection the whole model rests on.

## The evidence comment is the sharp end of this

A general comment on a pull request is an _issue_ comment
(`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`), and GitHub's own reference does not state whether
a fine-grained App holding `pull_requests: write` but **not** `issues: write` can post one. The docs assert that
every pull request is an issue and that the Issues endpoints carry the shared actions, then decline to say what
that means for permissions.

This is not a detail. The evidence comment is the first place a human meets a bounty's output
([evidence](../../../docs/capabilities/11-evidence.md), and [where evidence surfaces first](./where-evidence-surfaces-first.md)),
so the answer decides whether bebop's App asks for write access to every issue in the repository — including
issues with nothing to do with any bounty — in order to comment on its own pull requests. `issues: write` is a
materially wider grant than `pull_requests: write`, and the security model is worth the narrower one if it
works.

So on top of the general set, establish:

- whether an App with `pull_requests: write` and no `issues` permission can create an issue comment on a pull
  request, and what the failure looks like if it cannot;
- whether the same holds for editing and deleting a comment it authored, since evidence is republished as
  invalidation re-runs the gates
  ([Every commit invalidates every downstream result (ADR 0016)](../../../docs/adr/0016-every-commit-invalidates-every-downstream-result.md));
- whether `issues: write` on a repository grants anything on pull requests that ADR 0034 assumes only the
  ruleset can grant — the concern is a permission that quietly widens what the sandbox identity could do if it
  were ever the one holding it;
- whether review comments (`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`) are a usable alternative
  under `pull_requests: write` alone, and what that costs in readability for a bundle of screenshots and
  validator logs.

## Where the answer goes

The permission set belongs in the ADR that records it — either as new consequences on ADR 0034, whose subject is
the same identity split, or as its own decision if the set turns out to carry tradeoffs of its own. If
`issues: write` proves load-bearing, it is a grant the design accepts and says so, rather than an oversight
discovered later.

Closing this closes the **Still open** questions on both
[the security model](../../../docs/capabilities/14-the-security-model.md) and
[pull request and merge](../../../docs/capabilities/12-pull-request-and-merge.md).
