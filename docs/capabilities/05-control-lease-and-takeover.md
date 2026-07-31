# Control lease and takeover

An autonomous run is not an opaque batch job. You can watch every seat continuously, take control of any active
agent, steer it, and hand it back — and exactly one actor may drive a seat at a time, so stepping in never
corrupts the bounty's state by accident.

## What you can expect

- **Observation always, input never by accident.** You can read any seat pane at any time. A seat whose lease
  Swordfish holds will not accept your keystrokes, and a prompt reaching it by any other route is rejected.
- **Takeover is explicit and recorded.** `sf takeover <seat>` interrupts the seat at a safe point, transfers the
  lease, enables input, and records that it happened. `--force` interrupts immediately.
- **A second client if you want one.** Takeover can issue the seat's credential so you can attach a wider
  terminal or a separate SSH session. `sf status` never prints it.
- **Handback is explicit too.** Swordfish never infers that closing SSH means autonomous work should resume — a
  disconnected user leaves the bounty `human_controlled` until you say otherwise.
- **Your access ends when control does.** Every release revokes any credential issued during that episode, so a
  client left attached in another terminal stops working the moment control returns.
- **Steering is honest in the record.** Human-steered review and QA results stay valid but are marked
  `human_steered` in their evidence provenance.
- **Constraint exhaustion hands you the wheel.** When a bounty burns its turn or wall-clock budget it enters
  `needs_attention`; handing control back grants one extra life to the exhausted constraint only, never a global
  reset.

## Where it stands

**Partial.** Takeover, handback, and lease ownership are modelled as durable state transitions in the shared
workflow core and Swordfish persists them, and `sf` exists as a control client. None of the four enforcement
layers is built, because all four need OpenCode and the cockpit. The prototype that proved the design is the
reason there are four layers rather than two.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **12** (ein's pane visible but refusing input), **13** (a
prompt by any other route is rejected by the plugin), **31** (the user can take over from the cockpit), **32**
(takeover provenance is recorded), and **33** (handback resumes or revises the effective spec).

## Decisions

- [The four-layer control lease (ADR 0009)](../adr/0009-the-control-lease-is-enforced-in-four-layers.md) — tmux
  for UX, the plugin for model turns, transport for the routes the plugin cannot see, detection for everything
  else. Bypass by a determined operator with a shell is accepted; accidental bypass is not.
- [Seat credentials die with the lease (ADR 0010)](../adr/0010-no-human-held-seat-credential-survives-a-control-release.md)
  — without rotation, the first takeover makes every later lease advisory.
- [The VM is the sandbox (ADR 0012)](../adr/0012-the-vm-is-the-sandbox.md)

## Still open

- [What is a safe point to interrupt a seat, and what does takeover do at each stage?](../../.scratch/bebop-mvp/issues/06-what-is-a-safe-point-to-interrupt-a-seat.md)
- [What is the `sf` command surface, in use?](../../.scratch/bebop-mvp/issues/07-the-sf-command-surface.md)
- [What are the default constraints, and what happens when one is exhausted?](../../.scratch/bebop-mvp/issues/09-default-constraints-and-exhaustion.md)
