---
type: research
status: resolved
---

# What GitHub App permissions are actually needed, and how is the target branch protected?

## Question

The provisional answer is contents RW, pull_requests RW, checks and statuses read, metadata read, on an
identity separate from the exe.dev push App. The security model depends on the sandbox being unable to update
the protected merge target, which is a claim about GitHub's configuration, not about Bebop's code.

The provisional mitigations, none of them verified against a real repository:

- default, release, and other sensitive branches use GitHub rulesets;
- the exe.dev GitHub App cannot bypass those rules;
- merge targets require pull requests and required checks;
- bebop verifies the exact head SHA before merge, and only bebop merges;
- bounty branches use the recognisable `bounty/*` namespace;
- unexpected branch-head movement invalidates readiness.

Establish:

- the minimum permission set that supports branch creation, push, draft PR lifecycle, check polling, comments,
  and squash merge — and what each one grants beyond what is needed;
- how the VM's push credential is scoped, and whether it can be restricted to `bounty/*` refs; if it cannot,
  what branch protection has to do instead;
- what protected-branch configuration the target repository must carry for
  [Squash-only merges (ADR 0017)](../../../docs/adr/0017-squash-only-merges.md) to hold, and whether that can
  be verified by bebop rather than assumed;
- how check polling behaves against rate limits at the fleet sizes this is meant to reach;
- what the App sees on a repository it has not been installed on, so the failure is a clear refusal rather than
  a confusing one.

## Answer

Established against `ferntheplant/bebop-gh-probe`, a throwaway public repository, on 2026-08-02. Twelve probes:
direct push, namespaced push, three merge methods, required-status-check gating at three check states,
SHA-pinned merge, force-push, deletion, and an invisible repository. The ruleset used is reproduced below so the
run can be repeated.

> The probe repositories `ferntheplant/bebop-gh-probe` and `ferntheplant/bebop-gh-probe-private` still exist —
> deleting them needs the `delete_repo` scope (`gh auth refresh -h github.com -s delete_repo`). They hold
> nothing but a README and are safe to delete at any time.

### The mitigation list holds, but not for the reason it assumed

Every provisional mitigation survives contact, with one correction and one addition.

**The two identities cannot be separated by permission scope.** An installation access token narrows to
repositories and permissions only — there is no ref-pattern scoping, so the VM's push credential _cannot_ be
restricted to `bounty/*`. Worse, merging a pull request requires `contents: write`, the same permission the
sandbox needs to push at all. The provisional answer's "identity separate from the exe.dev push App" therefore
buys auditability, not authority: both identities hold the permission that would let them write `main`.

**The ruleset is the entire security model, and it is sufficient.** A `pull_request` rule on the default branch
rejected a direct push from the _repository owner_ with `GH013 … Changes must be made through a pull request`.
Rulesets have no implicit admin exemption — unlike classic branch protection, where administrators are exempt
unless the box is ticked. The default is deny.

**No bypass list is needed.** This is the finding that simplifies the design. Because merging _through the pull
request API_ satisfies the pull-request rule, bebop merges with no privilege the sandbox lacks — it merely does
the one thing a ruleset permits. An empty `bypass_actors` is the correct configuration, and the question of
whether the exe.dev App can bypass the rules becomes moot: nobody can.

### Squash-only (ADR 0017) is enforced and machine-verifiable

`allowed_merge_methods: ["squash"]` inside the `pull_request` rule is enforced server-side:

| merge method | result                                                  |
| ------------ | ------------------------------------------------------- |
| `merge`      | `405 Merge commits are not allowed on this repository.` |
| `rebase`     | `405 Rebase merges are not allowed on this repository.` |
| `squash`     | merged                                                  |

The same value is readable back from `GET /repos/{owner}/{repo}/rules/branches/{branch}`, so
[Squash-only merges (ADR 0017)](../../../docs/adr/0017-squash-only-merges.md) is verifiable rather than assumed.

### Bebop can verify protection instead of trusting it

`GET /repos/{owner}/{repo}/rules/branches/{branch}` returns the _effective_ rules for a branch and needs no
elevated permission. It yields three distinguishable states, which is exactly what
[Readiness is a claim (ADR 0003)](../../../docs/adr/0003-readiness-is-a-claim-not-authority.md) needs to fail closed with a
diagnosis rather than a shrug:

| response                      | meaning                                  | bebop's move                         |
| ----------------------------- | ---------------------------------------- | ------------------------------------ |
| `200` + rules array           | enforced; contents say which             | verify the rules it requires         |
| `200` + `[]`                  | plan supports rules, none configured     | refuse — target is unprotected       |
| `403 Upgrade to GitHub Pro …` | plan does not support rules on this repo | refuse, and say which plan is needed |

**A plan dependency falls out of this.** Rulesets are enforced on public repositories on every plan, but on
private repositories only from GitHub Pro / Team / Enterprise up. On a Free personal account the API refuses
ruleset _creation_ on a private repo with `403`, and refuses to read rules there too — it does not silently
accept an unenforced ruleset, which is the failure mode that would have been dangerous. (The
"configured but not enforced" banner reported in the wild is an organization-plan-downgrade case, not this one.)
So: **bebop's merge target must be a public repository, or live under a paid plan.** That is a constraint on who
can adopt Bebop safely, so it is stated where users read about merging —
[pull request and merge](../../../docs/capabilities/12-pull-request-and-merge.md) — rather than only in
[the security model](../../../docs/capabilities/14-the-security-model.md), which describes properties of the
system rather than conditions on the user's repository.

### Required checks gate the merge, at all three states

With `required_status_checks` requiring context `bebop/verify`:

| check state on the head SHA | merge result |
| --------------------------- | ------------ |
| never reported              | `405`        |
| reported `failure`          | `405`        |
| reported `success`          | merged       |

This is the polling loop of [Swordfish connects outbound only (ADR 0013)](../../../docs/adr/0013-swordfish-connects-outbound-only.md) working end to end without ingress.

### The SHA pin works — but only after mergeability settles

The merge API's `sha` parameter is the guard behind "bebop verifies the exact head SHA before merge", and it
holds: with the branch head moved after readiness was claimed, a merge pinned to the stale SHA is refused.

The operational catch is the error it refuses _with_. GitHub computes `mergeable` asynchronously after a push.
Attempted immediately, the pinned merge returns `405 Pull Request is not mergeable` — indistinguishable from a
genuine conflict. Only once `mergeable` is non-null does it return the diagnostic
`409 Head branch was modified. Review and try the merge again.`

**Therefore: bebop must poll `mergeable` to non-null before attempting a SHA-pinned merge, and must treat `405`
as "retry once mergeability settles", never as "conflict".** Reading 405 as a conflict would make a
merge-too-soon look like base drift and misfire
[Base drift is conflict-gated (ADR 0033)](../../../docs/adr/0033-base-drift-is-conflict-gated.md). This cost two confounded
probe runs to see, and it will not be visible in any test whose fixture pushes and merges slowly.

### Minimum permission set

Corrected from the provisional answer:

| permission      | level | why                                                       |
| --------------- | ----- | --------------------------------------------------------- |
| `contents`      | write | create `bounty/*` refs, push, and merge the PR            |
| `pull_requests` | write | open, update, and mark ready for review                   |
| `checks`        | read  | poll check runs and suites                                |
| `statuses`      | read  | poll commit statuses                                      |
| `metadata`      | read  | mandatory prerequisite                                    |
| `issues`        | write | **addition** — a general PR comment is an _issue_ comment |

The `issues: write` addition is the gap: the provisional set cannot post the evidence comment that
[evidence](../../../docs/capabilities/11-evidence.md) and [where evidence surfaces first](./where-evidence-surfaces-first.md) both depend on. Whether `pull_requests: write`
alone suffices for issue comments on a PR is undocumented and was not settled here — it needs a real App
installation, and is carried as [which permission posts the evidence comment](./permission-required-to-post-the-evidence-comment.md). Treat
this row as provisional until that resolves.

`contents: write` is the permission to be uncomfortable about: it is unavoidable for both pushing and merging,
and it is what makes the ruleset load-bearing rather than defence-in-depth.

### Rate limits are not a constraint at MVP fleet size

Installation tokens get 5,000 requests/hour, +50/hour per repository beyond 20 and +50/hour per user beyond 20,
capped at 12,500 (15,000 on Enterprise Cloud). No more than 100 concurrent requests, shared across REST and
GraphQL.

At one check-poll per bounty per 10s a bounty costs 360 requests/hour, so the 5,000 floor holds roughly 13
concurrent bounties before polling alone exhausts it; at 30s intervals, about 41. The map's six-live-bounties
figure costs 2,160/hour at 10s — comfortable, but it is _43% of the floor spent on polling_, which argues for a
30s default and a backoff once a bounty is known to be waiting on a long check.

### Failure on an uninstalled repository is a clean refusal

A repository the caller cannot see returns `404 Not Found`, not `403` — GitHub does not confirm existence. The
refusal is unambiguous but uninformative by design: bebop cannot distinguish "not installed" from "does not
exist" and should say exactly that rather than guessing.

### Two loose ends

- The `deletion` rule could not be tested on the default branch: git refuses to delete the current branch before
  the ruleset is consulted. The rule is redundant on the default branch and only earns its place on non-default
  protected branches such as release branches.
- Organization-level rulesets, and their precedence when they meet a repository-level ruleset, were not tested —
  no organization exists yet. Bebop targets named repositories, so this is likely out of scope, but it is
  untested rather than ruled out.

### Reproduction

```json
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "bebop/verify" }]
      }
    },
    { "type": "non_fast_forward" }
  ]
}
```

### Follow-ups

- Recorded as
  [The merge target must enforce rulesets (ADR 0034)](../../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md),
  and surfaced to users in [pull request and merge](../../../docs/capabilities/12-pull-request-and-merge.md) —
  the plan constraint affects who can adopt Bebop, so it is not only an implementation detail.
- The one hole this ticket could not close is carried as
  [which permission posts the evidence comment](./permission-required-to-post-the-evidence-comment.md): whether `issues: write` is strictly
  required for the evidence comment, or whether `pull_requests: write` suffices for an issue comment on a pull
  request. Its answer either removes a row from the permission table above or promotes that row to a grant ADR
  0034 has to justify.
