# `.bebop/**` is permanently privileged, and approval is SHA-pinned

The candidate cannot be allowed to weaken the rules that evaluate it. `.bebop/**` is hardcoded as privileged and cannot be unprotected by editing it; repositories declare additional privileged globs in `config.yml`, which is read from the base revision so the glob list protects itself. Any candidate change under a privileged path forces `needs_attention`, and only a human running `bebop bounty approve-config --sha <candidate-sha>` clears it — recorded against that exact commit.

## Consequences

This intentionally makes legitimate repository-tooling work slower: a bounty that edits CI configuration or its own validators will stop for human inspection of the privileged diff, every time a new commit touches those paths. Unchanged privileged paths continue loading from base, and gates run from the approved candidate's configuration once approval exists.
