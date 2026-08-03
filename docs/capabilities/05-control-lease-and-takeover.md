# Control lease and takeover

An autonomous run is not an opaque batch job. You can watch every seat continuously, take workflow control from
the active cowboy, steer the same stage, invoke its workflow actions yourself, and hand control off again — and
exactly one actor may drive the active seat at a time.

## What you can expect

- **Observation always, input never by accident.** You can read any seat pane at any time. A seat whose lease
  Swordfish holds will not accept your keystrokes, and a prompt reaching it by any other route is rejected.
- **Takeover is explicit and recorded.** `sf takeover` infers the sole active cowboy seat, leaves stage unchanged,
  claims workflow control and the seat lease immediately, then enables input
  only after a quiescent handoff. Swordfish asks OpenCode to abort and automatically kills and restarts the seat
  after a configurable grace period; `--force` skips that grace period.
- **Progress is visible.** While input remains disabled, status names the seat and unchanged current stage, shows the
  graceful or forced path and its deadline, and says whether human access is ready or degraded.
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
- **Attention is actionable.** When a bounty enters `needs_attention`, status prints the exact `resume`, `rerun`,
  takeover, or bebop-side command that can resolve it.
- **Local mutations prove operator authority.** Every mutating or access-granting `sf` command requires hidden
  interactive entry of a per-bounty operator credential retrieved through an authenticated Bebop client; cowboy
  tools use a separate role-bound adapter.
- **Every action remains headless.** The same typed operations are available through authenticated Bebop HTTP
  routes and its thin CLI; local `sf` is the cockpit adapter, not the only route.
- **Resume, rerun, and cancel say exactly what changes.** `resume` clears only attention reasons that explicitly
  permit generic resumption and never bypasses config approval, intrusion, or uncertain recovery; `rerun` repeats
  one local gate on the same candidate with downstream invalidation and fresh execution context; `cancel`
  terminates the inner loop but leaves the cockpit and VM alive.
- **Every attention reason names its exits.** Config changes point to SHA-pinned Bebop approval; intrusion and
  uncertain seat state point to takeover and reconciled handoff or cancel; uncertain gates point to rerun; an
  unreconcilable environment points to cancel or Bebop's runtime-manifest recovery path.

## Where it stands

**Partial.** Takeover and lease ownership are modelled as durable events and `sf` exists as a control client, but
handoff, the orthogonal controller, the settled command surface, and operator authentication are not implemented.
The current reducer still represents `human_controlled` as a stage. None of the four enforcement layers or
role-aware action adapters is built.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **12** (ein's pane visible but refusing input), **13** (a
prompt by any other route is rejected by the plugin), **31** (the user can take over from the cockpit), **32**
(takeover provenance is recorded), and **33** (handoff returns the current stage to Swordfish).

## Decisions

- [The four-layer control lease (ADR 0009)](../adr/0009-the-control-lease-is-enforced-in-four-layers.md) — tmux
  for UX, the plugin for model turns, transport for the routes the plugin cannot see, detection for everything
  else. Bypass by a determined operator with a shell is accepted; accidental bypass is not.
- [Seat credentials die with the lease (ADR 0010)](../adr/0010-no-human-held-seat-credential-survives-a-control-release.md)
  — without rotation, the first takeover makes every later lease advisory.
- [The VM is the sandbox (ADR 0012)](../adr/0012-the-vm-is-the-sandbox.md)
- [Control passes through a quiescent handoff (ADR 0036)](../adr/0036-control-passes-through-a-quiescent-handoff.md)
  — takeover guarantees that the prior actor stopped, not that its partial work was rolled back.
- [One controller drives one active cowboy (ADR 0037)](../adr/0037-one-controller-drives-one-active-cowboy.md)
  — control is orthogonal to stage and follows manual transitions.
- [Workflow actions have role-aware adapters (ADR 0038)](../adr/0038-workflow-actions-have-role-aware-adapters.md)
  — why human CLI mutations need an operator credential while cowboy tools do not.

## Still open

- [What are the default constraints, and what happens when one is exhausted?](../../.scratch/bebop-mvp/issues/09-default-constraints-and-exhaustion.md)
