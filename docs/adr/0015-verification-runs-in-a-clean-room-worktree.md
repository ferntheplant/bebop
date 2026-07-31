# Verification runs in a clean-room worktree pinned to the candidate SHA

For every candidate, Swordfish creates an ephemeral worktree at that exact commit, with isolated ports and disposable service state, sharing no uncommitted files with ein's worktree, and destroys it once its evidence is captured. Checks ein ran itself are never authoritative evidence, however useful they were while developing.

An agent verifying its own working directory can pass on files it never committed, ports it left running, and databases it already seeded. The clean room is what makes a gate result a statement about the commit rather than about the agent's desk.

## Consequences

Only an explicit candidate submission can enter authoritative verification — a harness falling idle is not a candidate — because the clean room needs a specific SHA to pin to.
