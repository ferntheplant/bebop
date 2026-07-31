# Base drift invalidates only on conflict

When the base branch advances, a bounty's results are invalidated only if the pull request actually becomes
unmergeable. If it does, the bounty drops to revision and ein merges base back in; if it does not, "behind base
by N" is surfaced and nothing re-runs.

Invalidating on every base advance would re-run the whole pipeline each time an unrelated commit lands on main,
which on a busy target branch means a bounty can never reach `ready`. Merge-base staleness is the accepted
cost — a candidate can pass every gate against a base it is behind.

## Consequences

This is the one place where [full invalidation](./0016-every-commit-invalidates-every-downstream-result.md) is
deliberately not applied, because the trigger is someone else's commit rather than the candidate's.
