# The merge target must be a repository where rulesets are enforceable

Bebop refuses to operate against a merge target whose branch rules it cannot read back and confirm are in
effect. In practice that means the target repository is public, or its account is on GitHub Pro, Team, or
Enterprise — rulesets are enforced on public repositories on every plan, but on private repositories only from
Pro upward.

The constraint exists because nothing else separates bebop from the sandbox. A GitHub App installation token
narrows to repositories and permissions, never to a ref pattern, so a bounty VM's push credential cannot be
restricted to `bounty/*`. Merging a pull request requires `contents: write` — the same permission the sandbox
already holds in order to push at all. Two identities, one authority: the ruleset on the merge target is the
only thing that makes [`ABSTRACT.md`](../../ABSTRACT.md) §8 criterion 38 — the sandbox cannot update the
protected merge target — true, and without it that criterion is false no matter how the App identities are
arranged.

Because a ruleset denies everyone by default — including the repository owner, unlike classic branch protection
— and because merging _through the pull request API_ satisfies a `pull_request` rule, bebop needs no privilege
the sandbox lacks. `bypass_actors` stays empty. Bebop does not merge around the rules; it does the one thing the
rules permit.

Verification is a live check, not an assumption. `GET /repos/{owner}/{repo}/rules/branches/{branch}` returns the
effective rules for a branch and distinguishes three states: rules enforced, the plan supports rules but none
are configured, and the plan does not support rules here at all (`403`, naming the upgrade). Bebop refuses on
the second and third, and on the third it can say which plan is required.

## Consequences

This is an adoption constraint, not only an implementation detail, so it is stated where users read about
merging rather than buried in the security model. A team whose repositories are private and on a free plan
cannot use Bebop against them until they upgrade or make the target public.

The verification is what
[Readiness is a claim (ADR 0003)](./0003-readiness-is-a-claim-not-authority.md) rests on for its final
condition, and it is what makes
[Squash-only merges (ADR 0017)](./0017-squash-only-merges.md) enforced rather than merely intended: the
`allowed_merge_methods` value is readable back from the same call, and the API rejects `merge` and `rebase`
outright.

Rulesets carry no implicit admin exemption, so an operator cannot quietly hand-push a fix to the merge target
without first removing the rule — which is the intended behaviour, and worth knowing before it is discovered
during an incident.

The permission set the App needs was established the same way, against a live installation, and it is small:
`contents: write`, `pull_requests: write`, `checks: read`, `statuses: read`, and the mandatory `metadata: read`.
Nothing needs `administration`. Reading back the effective rules — the verification this ADR rests on — is
satisfied by `metadata: read` alone, so bebop never holds the permission that could edit or remove the ruleset
protecting the merge target. Which contexts are required comes from that same call; whether they passed comes
from `checks: read` for check runs and `statuses: read` for the older commit-status API, and a target may use
either.

`issues: write` is deliberately not granted. A general comment on a pull request is an issue comment, and
GitHub's reference declines to say which permission posts one. Probing settles it: `pull_requests: write` alone
creates, edits, and deletes them, which matters because evidence is republished as invalidation re-runs the
gates. The alternative was write access to every issue in the repository — including issues no bounty touches —
in order to comment on bebop's own pull requests.

The two ways a call can fail are distinguishable, which is what lets bebop say which one happened rather than
reporting "GitHub said no". A missing permission is `403` with `Resource not accessible by integration` and an
`x-accepted-github-permissions` header naming what would have satisfied the route. A repository refusal is `405`
carrying a reason a human can read: `Rebase merges are not allowed on this repository.` Squash-only is therefore
enforced by the API rather than merely configured — `rebase` and `merge` are both refused where
`allowed_merge_methods` reads back as `["squash"]`.

One measurement trap is worth recording, because it yields an App that works until it first meets a private
repository. Every read succeeds against a **public** repository even with no permissions granted at all. A `200`
there proves the route is public, not that the grant is unnecessary; the accepted-permissions header is the
thing to read, on success as well as on failure.

Settled by probing a
live repository rather than reasoning from the documentation; several of the findings above contradict what the
docs imply.
