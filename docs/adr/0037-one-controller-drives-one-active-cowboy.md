# One controller drives one active cowboy

Swordfish models **stage** and **controller** as orthogonal workflow dimensions. Stage says what work the bounty
is doing; controller says whether Swordfish or a human is responsible for directing it. At most one cowboy seat
is active, and a human-control episode follows manually requested stage transitions and their active seats until
explicit handoff. `human_controlled` is therefore a derived Bebop status, not a Swordfish stage.

The previous model changed stage to `human_controlled` and stored a suspended work stage. That made takeover look
like leaving QA or review when the human was actually assuming responsibility for that exact work, and it made a
manual transition briefly return authority to Swordfish. Orthogonal control preserves the stage machine and
makes who drives it explicit.

## Consequences

A seat is one human-addressable OpenCode session occupied by a cowboy, not every child session the harness may
create. Ein's seat is reused for context continuity; every jet and faye attempt receives a fresh seat for
independence. Deterministic operations and external CI may run without an active cowboy. Takeover is refused
when no cowboy seat is active, while handoff may release an existing human-control episode from any stage.
