# Replay fails closed, and every no-op carries a reason

At-least-once delivery means events arrive twice. Reducers reject sequence gaps, treat exact replay as a no-op, and retain a bounded window of hashed event fingerprints so a _conflicting_ replay — same sequence, different content — fails rather than silently overwriting. Below the window's `fingerprintFloor` a replay reports `unverifiable_replay`; inside the window a missing fingerprint is an error, not a pass.

Every result that applies no event carries a reason, because the acknowledgement decision depends on which kind of no-op it was: `already_applied` and `unverifiable_replay` may be acknowledged, while `wrong_connection` must not — acknowledging an input bebop discarded makes Swordfish drop it from its outbox permanently.

## Consequences

Command deduplication follows the same shape on the Swordfish side: the payload hash and the encoded terminal result are stored under `command_id`, identical redelivery returns the stored result, and a different payload under the same ID is a protocol error.

Delivery is resumable in both directions — Swordfish pages a bounded window of events behind a local send cursor and resets it to bebop's durable acknowledgement on reconnect, and bebop queues commands durably while a bounty is offline. Freshness is scoped to a `connectionId` so stale traffic from a replaced connection cannot mutate the active projection.
