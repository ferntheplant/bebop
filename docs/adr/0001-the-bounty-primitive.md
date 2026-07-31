# The bounty is one VM, one branch, at most one PR

Bebop's unit of work is a bounty: one isolated exe.dev VM, one crew of role-bound seats, one assigned `bounty/<bounty-id>` branch, and at most one pull request. Everything else in the system — provisioning, verification, evidence, merge — is scoped to that one unit, which is what makes a bounty independently observable, independently steerable, and independently destroyable.

The alternative was a work model that could span several PRs or share compute between tasks. That buys parallel throughput inside one bounty at the cost of every recovery, invalidation, and authority rule needing to reason about partial scope. Large-project decomposition is deliberately built _from_ this primitive later, not designed into it now.

## Consequences

A bounty whose VM is permanently lost can be replaced while the logical bounty, its branch, its effective spec, and its master-side artifacts survive; the replacement starts with fresh Swordfish and seat state.
