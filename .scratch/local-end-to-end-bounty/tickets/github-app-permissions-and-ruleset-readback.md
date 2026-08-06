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

It has to be settled by probing rather than by reading. The findings behind
[The merge target must enforce rulesets (ADR 0034)](../../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md)
were reached by driving a live repository precisely because several of them contradicted what the documentation
implied — that a ruleset denies the repository owner, that merging through the pull-request API satisfies a
`pull_request` rule, that the plan-not-supported case is distinguishable from the no-rules-configured case.
Expect the same here.

Establish, against the live App:

- the minimum permission set for each thing bebop does — create and update a draft pull request, read check runs
  for an exact SHA, read back effective branch rules, post the evidence comment, and squash-merge through the
  pull-request API — and which of those are `contents`, `pull_requests`, `checks`, `issues`, or
  `administration`;
- whether `pull_requests: write` suffices to post the evidence comment or whether `issues: write` is required,
  which is the same question [the pull request capability](../../../docs/capabilities/12-pull-request-and-merge.md)
  and [the permission ticket](./permission-required-to-post-the-evidence-comment.md) already ask — answer it
  once, here, against the live installation;
- what the ruleset verification call returns in each of its three states, and whether `allowed_merge_methods`
  reads back the way ADR 0034 records;
- what an under-permissioned call fails with, so bebop can tell "the App lacks a permission" from "the
  repository refused" and say which;
- whether any of it needs `administration`, which would be worth knowing before granting it — an App that can
  reconfigure rulesets can remove the protection the whole model rests on.

The answer closes the **Still open** question on the security model and either closes or absorbs the evidence
comment permission ticket.
