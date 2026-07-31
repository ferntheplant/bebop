# Swordfish connects outbound only, and CI is observed by polling

Each Swordfish initiates a reconnecting WebSocket **out** to bebop; bebop never dials into a bounty VM. Bebop's own ingress stays private (an exe.dev private URL plus named bearer tokens), which means no inbound webhooks either — so pull-request checks are observed by polling GitHub rather than by receiving check events.

Outbound-only means a bounty VM needs no reachable address, no inbound firewall rule, and no stable DNS, and it keeps working behind whatever networking exe.dev gives it. Keeping bebop's ingress private removes an entire attack surface from an always-on service that holds merge authority.

## Consequences

Polling costs latency and API quota that a webhook would not, and it is the reason public ingress appears on the deferred list — adding it later unlocks webhooks and inbound integrations together.

Because the connection is long-lived and at-least-once, delivery must be resumable in both directions: Swordfish pages a bounded window of events behind a local send cursor and resets that cursor to bebop's durable acknowledgement on reconnect, and bebop queues commands durably while a bounty is offline.
