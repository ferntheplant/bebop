# Workflow actions have role-aware adapters

Swordfish exposes one typed, named workflow-action interface. Cowboy tools, human OpenCode slash commands, the
local `sf` CLI, and authenticated Bebop commands are adapters to the same transition implementation; there is no
raw set-stage operation. Authorization includes the caller kind, cowboy role, seat, controller, and current
stage, so a human can manually perform the same legitimate work as the cowboy whose seat they took over without
creating a second state machine.

The local CLI adapter needs separate proof of operator authority. A same-user Unix socket cannot distinguish a
human shell from a cowboy spawning `sf`, so every mutating or access-granting local command requires hidden
interactive entry of a per-bounty operator credential. Bebop derives it from a master-held secret and Swordfish
receives only a verifier. An authenticated Bebop client retrieves the plaintext explicitly; it is never placed in
VM configuration, attachment metadata, or logs. Read-only status and events remain unprompted; automation uses
Bebop's authenticated interface rather than a noninteractive local bypass.

The credential stops a **confused** cowboy, not a compromised one, and that limit is deliberate. A cowboy that
hallucinates `sf cancel` or is prompt-injected into running it cannot produce a secret it was never given. A
cowboy that is actually adversarial runs at the same uid inside the VM and can shim `sf` earlier on `PATH`,
`ptrace` the running process, or `capture-pane` the tmux session the operator typed into — all of which
[The VM is the sandbox (ADR 0012)](./0012-the-vm-is-the-sandbox.md) already places outside the model, which is
why high-value authority lives with bebop instead. Defending the local socket against a hostile same-uid process
is not attempted here, and an implementation should not spend complexity pretending otherwise.

The credential is therefore derived deterministically by HMAC from the master key under a domain string distinct
from the machine credential's, and never rotates, matching
[Swordfish tokens are bounty-scoped, minted at provisioning, and never rotate (ADR 0014)](./0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md)
for a credential of identical scope and lifetime. Derivation means retrieval recomputes rather than reads, so
there is no stored plaintext to lose, and a retried provision yields the same credential. Recovery from a
suspected leak is destroying the bounty's VM, which the operator can already do. Because the credential is a
256-bit digest rather than a human-chosen secret, the verifier Swordfish stores is a plain SHA-256 digest like
`hashSwordfishToken` — there is no dictionary to precompute, so salting and key stretching would add ceremony
and cost the determinism that keeps provisioning retries stable.

Retrieval emits no event on the bounty's stream. It changes no workflow state — the credential was already valid
from provisioning, so there is nothing for a projection to record. A retrieval event would be noise on every
client's timeline and still a partial audit, because the local `sf` commands that spend the credential run on the
VM and are invisible to Bebop. The record of operator authority is the authenticated retrieval, not the stream.

That record is the handler's own log line, not a property the route gets for free. Bearer authentication
annotates `api_token_id` onto the endpoint's effect, but annotations only reach logs something actually emits and
there is no access-log middleware, so a handler that logs nothing leaves no trace at all. The retrieval handler
therefore logs the retrieval explicitly, with `bounty_id` and `vm_id`. Any future route that hands out a secret
carries the same obligation.

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
