# Constraint exhaustion is computed, not announced

The pure workflow reducer owns constraint accounting and the exhaustion predicate. It accrues turns from
`turn_completed` events and attempt wall clock from event timestamps, and it decides whether an attempt is over
budget. An `attention_required` event claiming `constraint_exhausted` is checked against that accounting and
rejected as an illegal transition when the reducer's own arithmetic says the attempt is still within budget.

Every event carries `occurredAt`, so elapsed time is exactly computable at any event rather than approximable.
The alternative — a watchdog that declares exhaustion and is believed — makes the daemon's clock the authority
over a rule that is otherwise pure and tested. A skewed clock, a leaked timer, or a watchdog that miscounts a
pause would then strangle healthy attempts silently, and the operator would see an exhaustion that the durable
event stream does not support. Rejecting the claim turns each of those bugs into one loud failed transition
instead. The reducer's accounting is the tested artefact, so a divergence between it and the daemon is a defect
worth failing on rather than absorbing.

A wake-up is still required, because the reducer can only evaluate at event boundaries and the wall-clock budget
exists for the case where boundaries stop arriving. A cowboy wedged on a hung tool call emits no
`turn_completed`, so the condition fires exactly when the reducer has nothing to fire on; the turn budget has no
such gap, since every increment is itself an event. That wake-up reuses the heartbeat loop
(`apps/swordfish/src/protocol/client.ts`) rather than adding a timer: Swordfish already wakes on
`heartbeatInterval` to send one, and seconds of cadence is far finer resolution than budgets measured in tens of
minutes.

The check runs where the heartbeat is produced, not where it is received. The ledger is Swordfish's state
([Bebop owns authority, Swordfish owns the loop (ADR 0002)](./0002-bebop-owns-authority-swordfish-owns-the-loop.md)),
and Bebop cannot write workflow events, so a Bebop-side detector would have to send a command and wait — a round
trip to decide something available locally. Worse, Swordfish keeps running through disconnection
([Swordfish connects outbound only (ADR 0013)](./0013-swordfish-connects-outbound-only.md)), so a detector on
Bebop's side would stop enforcing the budget during exactly the partition it is meant to bound.

## Consequences

The constraint ledger introduces no timing mechanism. `attempt_started`, `turn_completed`, and `attempt_ended`
are the only new events, and the recovery grants ride on `attention_cleared` as resolutions rather than as event
types of their own.

Bebop's projection applies the same reducer, so it can compute the same elapsed time from the same events with
no change to `HeartbeatMessage` — it already carries `sentAt`, and the projection already holds the attempt,
controller, and stage. A projection that reads an attempt as long past budget while Swordfish has raised no
attention is therefore a **defect signal about the daemon**, not an exhaustion: it re-verifies a claim the way
[Readiness is a claim (ADR 0003)](./0003-readiness-is-a-claim-not-authority.md) already has Bebop re-verify
readiness. Because the projection lags the daemon by at least the delivery of one event, that cross-check needs
a grace margin over the heartbeat interval, which is tolerable for a defect signal and disqualifying for a
primary detector.

The clock runs only while an attempt is active, the controller is Swordfish, and the stage is not
`needs_attention`. That predicate is expressible only because those are independent dimensions
([One controller drives one active cowboy (ADR 0037)](./0037-one-controller-drives-one-active-cowboy.md)); when
human control and attention were mutually exclusive stages, a bounty paused for both reasons had no
representation, and clearing one would have restarted the clock while the other still applied.

Two requirements from
[the constraint ticket](../../.scratch/bebop-mvp/issues/09-default-constraints-and-exhaustion.md) need no
special handling under timestamp accounting. Daemon downtime counts toward the attempt, which falls out of the
gap between the last pre-crash event and the first post-restart one, provided the running-since mark is in the
durable snapshot. Deterministic gates and external waits are excluded structurally rather than by rule, because
an accepted `candidate-ready` submission ends the ein attempt before local validation runs, so no attempt is
active during validation, the CI poll, or evidence upload.
