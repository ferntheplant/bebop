# Control lease and takeover

An autonomous run is not an opaque batch job. You can watch every seat continuously, take workflow control from
the active cowboy, steer the same stage, invoke its workflow actions yourself, and hand control off again — and
exactly one actor may drive the active seat at a time.

## What you can expect

- **Observation always, mixed model turns never.** You can read and interact with any seat pane at any time, but
  the plugin rejects a human model prompt while Swordfish controls that seat. An unexpected TUI shell, abort,
  revert, or unrevert is recorded as an intrusion and suspends the stage rather than silently mixing actors.
- **Takeover is explicit and recorded.** `sf takeover` infers the sole active cowboy seat, leaves stage unchanged,
  claims workflow control and the seat lease immediately, then grants human workflow authority
  only after a quiescent handoff. Swordfish asks OpenCode to abort and automatically kills and restarts the seat
  after a configurable grace period; `--force` skips that grace period.
- **Progress is visible.** During takeover, status names the seat and unchanged current stage, shows the graceful
  or forced path and its deadline, and says whether human authority is ready or degraded.
- **A second client if you want one.** `sf attach` obtains the active seat credential internally and execs an
  attached OpenCode client without printing the secret.
- **Handoff is explicit too.** `/handoff` and `sf handoff` release control without changing stage. Swordfish never
  infers that closing SSH means autonomous work should resume.
- **Control follows your transitions.** If you run `reopen-spec`, complete a gate, or submit a candidate, human
  control follows into the resulting stage and active seat until handoff.
- **Your access ends when control does.** Every release revokes any credential issued during that episode, so a
  client left attached in another terminal stops working the moment control returns.
- **Steering is honest in the record.** Human-steered review and QA results stay valid but are marked
  `human_steered` in their evidence provenance.
- **Attention is actionable.** When a bounty enters `needs_attention`, status prints the exact `resume`,
  `continue`, `rerun`, takeover, or bebop-side command that can resolve it.
- **Local mutations prove operator authority.** Every mutating or access-granting `sf` command requires hidden
  interactive entry of a per-bounty operator credential retrieved through an authenticated Bebop client; cowboy
  tools use a separate role-bound adapter.
- **Every action remains headless.** The same typed operations are available through authenticated Bebop HTTP
  routes and its thin CLI; local `sf` is the cockpit adapter, not the only route.
- **Resume, continue, rerun, and cancel say exactly what changes.** `resume` clears only a safe non-budget
  suspension and changes no allowance; `continue` preserves the suspended final attempt and resets its turn/time
  watchdogs; `rerun` starts a fresh stage attempt or deterministic validation operation; `cancel` terminates the
  inner loop but leaves the cockpit and VM alive.
- **Every attention reason names its exits.** Config changes point to SHA-pinned Bebop approval; intrusion and
  uncertain seat state point to takeover and reconciled handoff or cancel; uncertain gates point to rerun; an
  unreconcilable environment points to cancel or Bebop's runtime-manifest recovery path.

## Where it stands

**Partial.** The orthogonal controller is implemented: stage, controller, and attention are three independent
dimensions in the shared workflow core, `human_controlled` is derived by Bebop rather than reported as a stage,
at most one cowboy seat can be active, and takeover and handoff change control without touching stage. Every
attention record carries a kind that names the commands permitted to clear it, and both `sf status` and
`bounty status` print them.

Not built: the quiescent handoff itself — abort, the ten-second grace period, and forced restart are decided but
unimplemented, so control changes hands today without waiting for the previous actor to stop. The settled command
surface, operator authentication, prompt denial, isolated seat transport, unexpected-mutation detection, and
role-aware action adapters are also outstanding.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **12** (ein's pane stays visible while an unauthorized human
prompt is refused), **13** (a prompt by any other route is rejected by the plugin), **31** (the user can take over from the cockpit), **32**
(takeover provenance is recorded), and **33** (handoff returns the current stage to Swordfish).

## Decisions

- [The control lease blocks mixed model turns, not trusted cockpit input (ADR 0039)](../adr/0039-the-control-lease-blocks-mixed-model-turns-not-trusted-cockpit-input.md)
  — the plugin guards model turns, transport isolates the seat, and unexpected TUI mutations are detected; tmux
  does not pretend to make a cockpit with free shells read-only.
- [Seat credentials die with the lease (ADR 0010)](../adr/0010-no-human-held-seat-credential-survives-a-control-release.md)
  — without rotation, the first takeover makes every later lease advisory.
- [The VM is the sandbox (ADR 0012)](../adr/0012-the-vm-is-the-sandbox.md)
- [Control passes through a quiescent handoff (ADR 0036)](../adr/0036-control-passes-through-a-quiescent-handoff.md)
  — takeover guarantees that the prior actor stopped, not that its partial work was rolled back.
- [One controller drives one active cowboy (ADR 0037)](../adr/0037-one-controller-drives-one-active-cowboy.md)
  — control is orthogonal to stage and follows manual transitions.
- [Workflow actions have role-aware adapters (ADR 0038)](../adr/0038-workflow-actions-have-role-aware-adapters.md)
  — why human CLI mutations need an operator credential while cowboy tools do not.
- [Continue preserves an attempt; rerun replaces it (ADR 0041)](../adr/0041-continue-preserves-an-attempt-rerun-replaces-it.md)
  — the recovery command names whether the operator is preserving context or starting again.
