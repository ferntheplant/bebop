# Squash-only merges, crew authorship, conflict-gated base drift

Bebop squash-merges and does nothing else. Commits are authored by the acting seat (`ein (bebop)`), pushed by the exe.dev App, and never attributed to the user's identity. When the base branch advances, results are invalidated only if the pull request actually becomes unmergeable — in which case the bounty drops to revision and ein merges base back in.

Squash keeps one bounty's agent-generated history as one reviewable commit on the target branch. Crew authorship keeps the provenance honest: a human who never wrote the code should not appear to have. Conflict-gating base drift avoids re-running the whole pipeline every time an unrelated commit lands on main; "behind base by N" is surfaced instead, and merge-base staleness is accepted.

## Consequences

The sandbox cannot update the protected merge target directly — the only path to the target branch is an explicit human merge command through bebop.
