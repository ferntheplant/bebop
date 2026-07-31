# Postgres for bebop, SQLite for Swordfish

Bebop's authoritative state lives in Postgres on the master VM; Swordfish's authoritative state lives in SQLite inside the bounty VM. Neither store is replicated to the other — bebop holds a projection of Swordfish's stage, not a copy of its state.

Each store matches its owner's failure model. Bebop is a long-lived multi-tenant service that needs transactions across bounties, durable job queues, and blue/green deploys. Swordfish is a single-writer daemon on a disposable computer that must keep working while the network is gone, and whose durable truth should die with the VM it describes.

## Consequences

Both sides write durable intent before performing externally visible side effects, and every at-least-once message carries a stable ID or sequence number so replay is safe.
