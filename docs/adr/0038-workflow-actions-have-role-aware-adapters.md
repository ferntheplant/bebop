# Workflow actions have role-aware adapters

Swordfish exposes one typed, named workflow-action interface. Cowboy tools, human OpenCode slash commands, the
local `sf` CLI, and authenticated Bebop commands are adapters to the same transition implementation; there is no
raw set-stage operation. Authorization includes the caller kind, cowboy role, seat, controller, and current
stage, so a human can manually perform the same legitimate work as the cowboy whose seat they took over without
creating a second state machine.

The local CLI adapter needs separate proof of operator authority. A same-user Unix socket cannot distinguish a
human shell from a cowboy spawning `sf`, so every mutating or access-granting local command requires hidden
interactive entry of a random per-bounty operator credential. Bebop derives it from a master-held secret and
Swordfish receives only a salted verifier. An authenticated Bebop client retrieves or rotates the plaintext
explicitly; it is never placed in VM configuration, attachment metadata, or logs. Read-only status and events
remain unprompted; automation uses Bebop's authenticated interface rather than a noninteractive local bypass.

## Consequences

Workflow actions are named by intent (`set-spec`, `candidate-ready`, `continue`, `set-blocked`,
`review-complete`, `qa-complete`, and `reopen-spec`) and carry structured payloads. Human recovery and control
actions (`resume`, `rerun`, `takeover`, `attach`, `handoff`, and `cancel`) remain distinct because cowboys have no
legitimate reason to invoke them. External authority such as config approval, merge, CI control, VM stop, and
destruction remains Bebop-side only.

`continue` is actor-aware without letting a cowboy mint budget: a cowboy may request another prompt within its
current watchdogs, while only an authenticated human may revive an exhausted final attempt. The recovery
distinction is recorded in
[Continue preserves an attempt; rerun replaces it (ADR 0041)](./0041-continue-preserves-an-attempt-rerun-replaces-it.md).

Reason-specific attention cannot be cleared by a generic resume: each attention record declares its permitted
resolution actions. A human workflow action requires an existing human-control episode whenever a cowboy is
active; if no cowboy is active, an authenticated action such as `reopen-spec` may establish human control while
activating the next seat because there is no concurrent writer to quiesce.
