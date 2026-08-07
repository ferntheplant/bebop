# Bebop owns authority, Swordfish owns the loop

State is split by authority rather than duplicated: bebop is authoritative for bounty identity, VM identity, repository and branch, pull request, merge authorization, evidence metadata, and retention; Swordfish is authoritative for seat identities, the effective-spec revision, the current stage, the workflow controller, control leases, attempts and budgets, candidates, gate results, and its unsent outbox.

The split follows the trust line, not the convenience line. Bebop owns everything that reaches outside the sandbox, so a compromised or confused bounty VM cannot merge code, provision computers, or rewrite history. Swordfish owns everything inside one bounty's delivery loop, so the loop keeps running while bebop is unreachable.

## Consequences

Bebop keeps a durable **projection** of Swordfish's stage and controller so `bounty list` and `bounty status` answer while a VM is unreachable — and that projection must record freshness, because a disconnected Swordfish cannot be presented as currently working merely because its last event said `building`.

The obligation is symmetric. Because the loop keeps running while bebop is unreachable, a Swordfish that is fine and going nowhere is indistinguishable from a stuck one unless it says which it is, so `sf status` reports the connection beside the stage: connected, disconnected since a given moment with the next attempt due, or never connected since this process started. That state belongs to the reconnect loop and is read live rather than written to a column, since a stored copy is exactly the freshness problem this consequence exists to avoid. An unreachable bebop is not `needs_attention` — nothing is waiting on a human decision, only on a process.
