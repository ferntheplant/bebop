# Which permission posts the evidence comment — `issues: write`, or does `pull_requests: write` suffice?

Type: research
Status: open

## Question

[Ticket 12](./12-github-app-permissions-and-branch-protection.md) settled the minimum permission set against a
live repository, with one hole it could not close. A general comment on a pull request is an _issue_ comment
(`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`), and GitHub's own reference does not state whether
a fine-grained App holding `pull_requests: write` but **not** `issues: write` can post one. The docs assert that
every pull request is an issue and that the Issues endpoints carry the shared actions, then decline to say what
that means for permissions.

This is not a detail. The evidence comment is the first place a human meets a bounty's output
([evidence](../../../docs/capabilities/11-evidence.md), and ticket 16 on where it surfaces first), so the answer
decides whether Bebop's App asks for write access to every issue in the repository — including issues that have
nothing to do with any bounty — in order to comment on its own pull requests. `issues: write` is a materially
wider grant than `pull_requests: write`, and the security model is worth the narrower one if it works.

Establish, against a real App installation on a throwaway repository:

- whether an App with `pull_requests: write` and no `issues` permission can create an issue comment on a pull
  request, and what the failure looks like if it cannot;
- whether the same holds for editing and deleting a comment it authored, since evidence is republished as
  invalidation re-runs the gates
  ([Every commit invalidates every downstream result (ADR 0016)](../../../docs/adr/0016-every-commit-invalidates-every-downstream-result.md));
- whether `issues: write` on a repository grants anything on pull requests that
  [The merge target must enforce rulesets (ADR 0034)](../../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md)
  assumes only the ruleset can grant — the concern is a permission that quietly widens what the sandbox identity
  could do if it were ever the one holding it;
- whether review comments (`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`) are a usable alternative
  under `pull_requests: write` alone, and what that costs in readability for a bundle of screenshots and
  validator logs.

Requires creating a test GitHub App, which nothing on this map has needed yet. Whichever session does that
should record the App's configuration, because tickets 12 and 16 both want the same fixture.

If `pull_requests: write` suffices, the permission table in ticket 12 loses a row and the answer is recorded
there. If it does not, `issues: write` is load-bearing and belongs in ADR 0034's consequences as a grant the
design accepts rather than an oversight.
