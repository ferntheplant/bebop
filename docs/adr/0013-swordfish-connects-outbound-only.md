# Swordfish connects outbound only

Each Swordfish initiates a reconnecting WebSocket **out** to bebop; bebop never dials into a bounty VM. Bebop's
own ingress stays private — an exe.dev private URL plus named bearer tokens.

A bounty VM therefore needs no reachable address, no inbound firewall rule, and no stable DNS, and keeps working
behind whatever networking exe.dev gives it. Keeping bebop's ingress private removes an entire attack surface
from an always-on service that holds merge authority.

## Consequences

No inbound ingress means no webhooks, so pull-request checks are observed by **polling** GitHub. Polling costs
latency and API quota that a webhook would not, and it is why public ingress appears on the deferred list —
adding it later unlocks webhooks and inbound integrations together.
