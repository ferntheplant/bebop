---
type: build
status: open
---

# Set up bebop's GitHub App and the local target's ruleset, repeatably

## Background

[The local loop runs the production assembly (ADR 0046)](../../../docs/adr/0046-the-local-loop-runs-the-production-assembly.md)
puts two GitHub identities in the local loop. Bebop uses a real App installation, because the credential path
that ships to production must be the one exercised on a laptop rather than a PAT standing in for it. The machine
uses the operator's ambient Git and `gh` credentials and needs no setup at all.

What does need setup is everything around the App: creating it, choosing its permissions, installing it on the
target repository, and putting a ruleset on that repository's default branch. The ruleset is what stops an agent
pushing to the branch a bounty is supposed to open a pull request against — it denies everyone, including the
repository owner, per
[The merge target must enforce rulesets (ADR 0034)](../../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md).
That protection is accepted as partial: it does not stop one bounty's agent pushing to another bounty's branch,
which is out of scope until two bounties run at once.

Which App permissions are actually required is an open question on
[the security model](../../../docs/capabilities/14-the-security-model.md), and this ticket is where it gets
answered against a live installation rather than from the documentation.

## Scope

- Determine the minimum App permission set for what bebop actually does: create and update a draft pull request,
  read check runs for a SHA, read back branch rules, and squash-merge through the pull-request API.
- Record where the App's private key and installation id live locally, and how bebop reads them — the same
  question [ADR 0019](../../../docs/adr/0019-the-master-runs-on-exe-dev-with-mandatory-off-vm-backups.md) answers
  for the deployed master.
- Configure the ruleset on the local target's default branch and verify it reads back as enforced through
  `GET /repos/{owner}/{repo}/rules/branches/{branch}`, including the `allowed_merge_methods` value ADR 0017
  depends on.
- Make the whole thing repeatable rather than remembered: a wizard is the likely shape, since every step is one
  only a human with a GitHub account can perform.

## Done when

- A contributor with no prior setup can reach a working local App installation and an enforced ruleset by
  following one documented path.
- The required permission set is recorded, and the **Still open** question about it is closed on
  [the security model](../../../docs/capabilities/14-the-security-model.md).
- The ruleset verification call returns "rules enforced" against the local target, and a direct push to the
  default branch is refused.
