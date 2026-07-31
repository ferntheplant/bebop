# Swordfish's single-daemon authority is locked to its database, not its control socket

Swordfish derives a private lock socket beside its SQLite database and acquires it before the control socket and before any migration or reconciliation. The user-facing control socket path is independently configurable, so it cannot protect SQLite: two configurations naming the same database and different control paths would both start.

The database is also identity-bound — its singleton metadata records bounty ID, VM ID, repository slug, and assigned branch, and startup refuses to reuse a database under different configuration, because its durable outbox still names the original authority.

## Consequences

Startup fails closed around uncertain local resources generally: `integrity_check`, `foreign_key_check`, outbox completeness, child PIDs, and recorded worktree paths are inspected before work resumes, and reconciliation commits a durable `attention_required` event in the same startup transaction. An interrupted external operation is never assumed to have completed.
