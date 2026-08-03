# Control passes through a quiescent handoff

A control transfer guarantees quiescence, not rollback: the previous actor is no longer executing before the
next actor receives access, but partial worktree state and external side effects survive for inspection. A
takeover claims the lease immediately to stop new Swordfish work, withholds human access while OpenCode aborts,
and automatically kills and restarts the selected seat if a configurable ten-second grace period expires.

The alternative meanings of "safe point" were either unprovable or unhelpful. OpenCode cannot promise that a
file write, subprocess, or Git operation rolled back, while waiting indefinitely for natural completion makes
takeover useless against a stuck turn. Process quiescence is observable and enforceable; worktree consistency is
reconciled separately.

## Consequences

`--force` skips the graceful period rather than weakening the no-concurrent-writers guarantee. A failed forced
restart leaves the bounty human-controlled and degraded instead of returning uncertain authority to Swordfish.
Handback reverses the ordering: human access is disabled and any issued credential is revoked before the lease
returns, then Swordfish starts fresh work for the reconciled stage rather than resuming an aborted turn.
