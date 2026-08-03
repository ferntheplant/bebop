# What is the `sf` command surface, in use?

Type: prototype
Status: resolved

## Question

`sf status/takeover/handback/extend/retry/approve-config/stop` exists and works, but the set was adopted as a
provisional default and has never been used by a human steering a real bounty.

Build the cheapest possible thing to react to — a scripted transcript of a session at the cockpit, or `sf`
against a fabricated status — and settle:

- what `sf status` shows, and whether one screen can carry stage, lease, constraints, gates, and the candidate
  without becoming a wall;
- whether `extend` and `retry` are the right verbs for "give it another life" and "run that stage again", and
  whether a human under pressure would confuse them;
- what a human needs at the moment a bounty enters `needs_attention` — the current answer requires reading a
  status pane and then choosing a command, which may be one step too many;
- whether anything in the set should be a bebop-side command instead, given that `approve-config` already
  exists on both sides;
- what is missing. A command that would obviously be reached for and does not exist is the finding worth
  having.

## Answer

A scripted cockpit transcript exposed a deeper issue than command naming: the current CLI treats human control
as a collection of special commands layered over a stage machine designed only for cowboys. The resolved model
has one workflow-action interface, one current controller, and at most one active cowboy seat. The CLI, human
slash commands, and cowboy tools are role-aware adapters to that interface.

The throwaway transcript was deleted after the decisions below were captured.

### Stage, controller, cowboy, and seat

**Cowboy** is the singular generic term for a personified reasoning member of the crew: ein, jet, or faye.
Swordfish remains deterministic software and authoritative for workflow state; a cowboy is assigned responsibility
for a stage and may request only transitions valid for its role and the current state.

Stage and control are orthogonal. `human_controlled` is a compact Bebop status derived when the workflow
controller is human, not a Swordfish stage. A takeover leaves the current stage unchanged. If the human invokes
a workflow action that changes stage, human control follows into the next stage and its active seat until an
explicit handoff.

The coarse Swordfish stages are:

```text
creating_spec
→ building
→ validating
→ reviewing
→ qa
→ publishing_evidence
→ ready
```

`needs_attention` suspends one of those stages with a reason. `cancelling`, `cancelled`, and `failed` are the
other exceptional stages. Revision is `building` with feedback rather than a separate stage. PR creation, CI
polling, QA preparation, and evidence upload attempts are durable operations or gate state within the coarse
stage, not additional operator-facing stages.

At most one cowboy seat is active. A seat is exactly one human-addressable OpenCode session assigned to a
cowboy; nested OpenCode subagent sessions are not seats. Ein's seat is reused across spec creation, building,
and revision so its task context survives. Every jet and faye attempt, whether for a revised candidate or a
human-authorized rerun, gets a fresh seat. Inactive seats remain durable provenance.

### Shared workflow actions

The complete MVP action interface is:

```text
set-spec
candidate-ready
continue
set-blocked
review-complete
qa-complete
reopen-spec
```

Each action has one typed payload and one authorization rule. OpenCode exposes it as a role-bound cowboy tool and
as a human slash command while the seat is human-controlled. `sf` exposes the same action for manual use. There
is no raw `transition <stage>` command.

`set-blocked` records why the current controller cannot proceed and suspends the current stage as
`needs_attention`; system-detected exhaustion, repeated idle, intrusion, or uncertain recovery enters the same
stage directly with system provenance. `reopen-spec` is available from any stage except `cancelling`, `cancelled`,
or `failed`: it cancels the active attempt, invalidates the candidate, gates, and readiness, moves to
`creating_spec`, activates ein's durable seat, and carries or establishes human control when invoked through a
human adapter. Cancellation remains terminal.

When a cowboy is active under Swordfish control, a human `sf reopen-spec` is rejected until `sf takeover`
completes its quiescent handoff. A human may invoke it directly from a stage with no active cowboy, where there
is no concurrent seat to quiesce; the action then establishes human control as it activates ein. Cowboy tools
retain Swordfish control when they invoke the same action.

### Human command surface

The compact status view is the default for both bare `sf` and `sf status`:

```text
sf [status] [--watch] [--verbose] [--json]
sf events [--follow] [--json]

sf takeover [--force]
sf attach
sf handoff
sf resume [--extend <constraint>]
sf rerun <validation|review|qa>
sf cancel

sf set-spec --input <file|->
sf candidate-ready [--sha <commit>]
sf continue
sf set-blocked --reason <text>
sf review-complete --input <file|->
sf qa-complete --input <file|->
sf reopen-spec --reason <text>
```

The ordinary status screen fits in one cockpit pane and prioritizes stage, controller, active cowboy and seat,
candidate, spec revision, constraints, gates, actionable connection health, and the exact next commands when
attention is needed. IDs, event cursors, outbox counts, and full event payloads live behind `--verbose`,
`--json`, or `events`. `status --watch` continuously redraws the cockpit status pane; `events --follow` is the
diagnostic stream.

The mutating commands mean:

- `takeover` infers the sole active seat and fails if the current stage has no active cowboy. It leaves stage
  unchanged and performs the quiescent handoff already settled; `--force` skips the graceful abort window.
- `attach` is valid only after takeover access is ready. It obtains the active seat credential internally and
  execs OpenCode attach without printing the secret.
- `handoff` replaces **handback**. It is a pure control release: it never changes stage or invents a workflow
  action. Human input and issued seat credentials are revoked, state is reconciled, and the current stage is
  assigned to its cowboy. It also works after a human-triggered transition reaches a deterministic stage with no
  active cowboy, returning the workflow controller to Swordfish.
- `resume` is valid only when the recorded attention reason explicitly permits generic resumption, such as
  constraint exhaustion or a cowboy's `set-blocked`. It clears that suspension and returns to the recorded stage.
  If one exhausted constraint is the sole blocker it infers the one permitted extension; multiple choices
  require `--extend`. It refunds no budget, findings, attempts, or cost and preserves the current controller.
  Privileged config, intrusion, uncertain recovery, and other reason-specific attention can be cleared only by
  the exact action status names; `resume` cannot bypass them.
- `rerun` is a human-authorized retry of one local gate on the same candidate and spec revision. It invalidates
  that gate and every downstream gate, preserves upstream results, and starts a fresh clean-room operation or
  fresh jet/faye seat. External CI reruns remain bebop/GitHub-side authority.
- `cancel` terminates Swordfish's inner workflow through `cancelling` and `cancelled`, quiesces seats and tracked
  operations, captures available evidence, and cleans temporary resources. Swordfish, the cockpit, and the VM
  remain alive for inspection; only bebop stops or destroys the VM. Cancellation is terminal.

Attention records carry their allowed recovery actions so status never offers a generic bypass. Privileged
config names the SHA-pinned Bebop approval command. Intrusion names takeover followed by reconciled handoff or
cancel. An uncertain gate names rerun; uncertain cowboy-seat state names takeover; an environment that cannot be
reconciled names cancel or the Bebop-side runtime-manifest recovery path. `resume` appears only for exhaustion,
`set-blocked`, or another reason whose producer explicitly declared ordinary resumption safe.

`extend`, `retry`, `stop`, `handback`, seat arguments on `takeover` and `attach`, and local `approve-config` are
removed. Config approval, evidence retrieval, merge, external CI control, VM stop, and destruction are Bebop
authority. Status prints the exact bebop-side command when one is required.

Every post-takeover mutation has a matching human slash-command adapter. `takeover` has local `sf` and Bebop
adapters but no slash adapter because no human-controlled harness exists before it. `attach` is a local client
convenience that execs OpenCode and is not a workflow or state-changing operator action.

Every workflow action and state-changing operator action also has an authenticated Bebop HTTP operation and thin
`bebop bounty` command carrying the same typed payload. This is the headless machine-client path and the route
used when a local cowboy seat is unavailable or unhealthy. Existing attachment metadata remains the headless
client surface for connecting to a bounty; it does not promise that an HTTP caller can exec a local TUI.

The human retrieves or rotates the local proof explicitly from outside the VM:

```text
bebop bounty operator-credential <bounty-id>
bebop bounty operator-credential <bounty-id> --rotate
```

These authenticated commands intentionally reveal sensitive output; they never run as part of ordinary status
or attachment metadata.

### Authenticating the human CLI adapter

Mode `0600` on a same-user Unix socket does not distinguish a human shell from a cowboy spawning `sf`. Read-only
`status` and `events` need no further credential, but every mutating or access-granting `sf` command prompts with
safe hidden terminal input for a per-bounty operator credential. It is never accepted through a flag,
environment variable, file, or command history, and there is no noninteractive local bypass; machine automation
uses Bebop's authenticated interface.

Bebop derives the random credential per bounty from its master-held secret and keeps its authority outside the
VM; Swordfish receives only a salted verifier. An authenticated Bebop client can explicitly retrieve the
credential for entry at the hidden `sf` prompt, and can rotate it if lost or exposed; neither operation places
the plaintext in attachment metadata, the VM environment, or logs. A cowboy legitimately invokes shared
workflow actions through its role-bound OpenCode tool adapter, which preserves cowboy, seat, and stage identity.
It never needs to invoke the human CLI adapter and cannot use that adapter to bypass role authorization.
