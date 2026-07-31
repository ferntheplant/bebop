# Bebop owns authority, Swordfish owns the loop

State is split by owner rather than duplicated: bebop is authoritative for bounty identity, VM identity, repository and branch, pull request, merge authorization, evidence metadata, and retention; Swordfish is authoritative for seat identities, the effective-spec revision, the current stage, the control lease, attempts and budgets, candidates, gate results, and its unsent outbox.

The split follows the trust line, not the convenience line. Bebop owns everything that reaches outside the sandbox, so a compromised or confused bounty VM cannot merge code, provision computers, or rewrite history. Swordfish owns everything inside one bounty's delivery loop, so the loop keeps running while bebop is unreachable.

## Consequences

Bebop keeps a durable **projection** of Swordfish's stage so `bounty list` and `bounty status` answer while a VM is unreachable — and that projection must record freshness, because a disconnected Swordfish cannot be presented as currently working merely because its last event said `implementing`.
