---
type: build
status: open
---

# `sf status` reports the bebop connection beside the stage

Resolving this updates [The cockpit](../../../docs/capabilities/03-the-cockpit.md).

## Background

A Swordfish that cannot reach bebop is in a normal state, not a failed one:
[Bebop owns authority, Swordfish owns the loop (ADR 0002)](../../../docs/adr/0002-bebop-owns-authority-swordfish-owns-the-loop.md)
keeps the loop running while bebop is unreachable, and
[Readiness is a claim (ADR 0003)](../../../docs/adr/0003-readiness-is-a-claim-not-authority.md) means it can
legitimately reach ready with nobody listening. The bounty is then fine and going nowhere, and from the outside
that is indistinguishable from being stuck.

Bebop already solves the mirror image — its projection records freshness so a quiet Swordfish reads as stale
rather than as still working. This is the same honesty on the other side of the wire, and
[The local loop runs the production assembly (ADR 0046)](../../../docs/adr/0046-the-local-loop-runs-the-production-assembly.md)
makes it matter sooner, because locally the most common cause is an operator who has not started bebop yet.

An unreachable bebop is **not** `needs_attention`. Nothing is waiting on a human decision, only on a process,
and overloading that state makes it less informative everywhere it is used properly.

## Scope

- Report connection state through the control socket, and render it in `sf status` beside the stage: connected,
  or disconnected with how long it has been so and when the next attempt is due.
- Reconnect with bounded exponential backoff and jitter rather than a fixed interval — the existing
  `SWORDFISH_RECONNECT_MINIMUM_DELAY` and `SWORDFISH_RECONNECT_MAXIMUM_DELAY` bound it; what is missing is the
  shape between them and the reporting.
- Include the state in whatever the cockpit status line consumes, since it already promises bebop connection
  health there.

## Done when

- `sf status` distinguishes connected, disconnected-and-retrying, and never-connected, with a duration on the
  latter two.
- The state is derived from the live connection rather than stored — a compact status written to a column is the
  second copy this repo does not keep.
- Killing bebop mid-bounty leaves the stage advancing where it can, and `sf status` says why the rest is
  waiting.
- `vp run ready` passes.
