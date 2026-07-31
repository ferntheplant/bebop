# Squash-only merges

Bebop squash-merges and does nothing else — no merge commits, no rebase-and-merge. Squash keeps one bounty's
agent-generated history as one reviewable commit on the target branch, so the target's history reads as one
change per bounty rather than as the loop that produced it.

## Consequences

The sandbox cannot update the protected merge target directly — the only path to the target branch is an
explicit human merge command through bebop.
