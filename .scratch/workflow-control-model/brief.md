# Brief: the orthogonal control model

Bring `packages/workflow`, `packages/contracts`, Swordfish, and Bebop's projection into line with the control
and constraint decisions taken in ADRs 0036–0041. Those six ADRs resolved five map tickets and produced no code;
the shipped state model contradicts four of them.

Source tickets: [06](../bebop-mvp/issues/06-what-is-a-safe-point-to-interrupt-a-seat.md),
[07](../bebop-mvp/issues/07-the-sf-command-surface.md),
[08](../bebop-mvp/issues/08-cockpit-layout-and-log-panes.md),
[09](../bebop-mvp/issues/09-default-constraints-and-exhaustion.md),
[14](../bebop-mvp/issues/14-opencode-version-pin-and-upgrade-qualification.md).

## Why now

The transition core is pure and tested through its own interface, so all of this is reachable without exe.dev,
GitHub, or a paid model. It is also the floor every later ticket lands on: ticket 10's finding severities,
ticket 16's evidence surfacing, and ticket 19's manifest recovery all describe states this model cannot
currently hold. Each ticket resolved against the old model is a second thing to migrate later.

## What is wrong today

1. **Control is encoded as a stage.** `packages/workflow/src/core.ts:67` treats `human_controlled` as one of
   four suspending stages and stashes the real work stage in `suspendedStage`.
   [One controller drives one active cowboy (ADR 0037)](../../docs/adr/0037-one-controller-drives-one-active-cowboy.md)
   makes stage and controller orthogonal and demotes `human_controlled` to a derived Bebop status.
2. **CI and review are an unordered join.** `gateStage` (`packages/workflow/src/core.ts:86-100`) returns `pr_ci`
   when `code_review` passed first, so review may complete before CI ran.
   [CI gates cowboy review (ADR 0040)](../../docs/adr/0040-ci-gates-cowboy-review.md) requires CI to precede jet.
3. **Attention is a bare string.** `attentionReason: string | null` (`packages/workflow/src/state.ts:53`).
   [Workflow actions have role-aware adapters (ADR 0038)](../../docs/adr/0038-workflow-actions-have-role-aware-adapters.md)
   requires each attention record to declare the actions permitted to clear it, so a generic `resume` cannot
   clear a budget exhaustion.
4. **Nothing bounds an attempt.** `WorkflowCoreState` has no attempt, watchdog, or allowance field, so
   [Continue preserves an attempt; rerun replaces it (ADR 0041)](../../docs/adr/0041-continue-preserves-an-attempt-rerun-replaces-it.md)
   has nothing to act on.
5. **Nothing caps active cowboys.** `leases` is a per-role map with an `owner` on each entry; any number of roles
   may hold one, and lease ownership doubles as the control signal ADR 0037 makes orthogonal.

## The model

Three dimensions, independently readable:

| Dimension | Field        | Says                                    |
| --------- | ------------ | --------------------------------------- |
| Work      | `stage`      | what the bounty is doing                |
| Control   | `controller` | whether Swordfish or a human directs it |
| Attention | `attention`  | why it stopped, and what may clear it   |

`stage` keeps `needs_attention` and keeps `suspendedStage` alongside it: attention genuinely suspends the work,
and the stage to return to has to be remembered. What leaves the stage enum is `human_controlled` (now
`controller`) and `blocked` — `set-blocked` becomes a transition event that raises an attention record and moves
the stage to `needs_attention`, rather than a stage of its own. `isSuspended` therefore collapses from four
stages to two: `needs_attention` and `cancelling`.

`activeCowboy` replaces the `leases` map: at most one cowboy seat is active (ADR 0037), ein's seat is reused for
continuity while jet and faye get a fresh seat per attempt, and a deterministic stage may run with no cowboy at
all. Lease ownership stops being the control signal, because `controller` now is.

An attention record carries `kind`, `reason`, and the `resolutions` permitted to clear it — which is what lets
status print the exact command that resolves it, as
[control lease and takeover](../../docs/capabilities/05-control-lease-and-takeover.md) promises.

## Scope

**First PR — the orthogonal model. Shipped.**

- Contracts: stage enum, `Controller`, `AttentionKind`, `WorkflowResolution`, and the control, seat, and
  attention events.
- Core: `controller`, `activeCowboy`, and `attention` replace `leases` and `attentionReason`; CI strictly
  precedes review; takeover and handoff leave stage unchanged.
- Swordfish: snapshot, and the takeover/handoff commands that used to write a `human_controlled` stage.
- Bebop: projection, snapshot, `deriveBountyStatus`, the HTTP detail contract, and CLI rendering.
- Both golden fixtures, and the capability docs whose "where it stands" this invalidated.

Two things changed during review and are worth knowing before reading the code. **Attention is a list**, not one
record: a later, laxer reason must not widen the exits of an outstanding stricter one, so reasons accumulate at
most one per kind, and a resolution clears every outstanding record permitting it — the workflow resumes only
once none remain. And **seats are keyed by seat ID, not role**, because every jet and faye attempt takes a fresh
seat; repeated roles in the seat list are the normal case, and `activeCowboy` identifies by ID.

**Second PR — the constraint ledger (ADR 0041). Shipped.** Attempts per scope, the turn/wall-clock watchdog
pair, human grants, and the validated-candidate allowance, with `continue`/`rerun`/`resume` acting on them.
Split out because the orthogonal model is what an attempt suspension has to attach to. Read
[ticket 09's answer](../bebop-mvp/issues/09-default-constraints-and-exhaustion.md) first — it is the
specification, down to the default numbers and what does and does not consume an attempt. Its shape is settled
by
[Constraint exhaustion is computed, not announced (ADR 0042)](../../docs/adr/0042-constraint-exhaustion-is-computed-not-announced.md):

- Contracts: `ConstraintProfile` takes the shape ticket 09 settled — `validatedCandidatesPerSpec`, and a
  `building`/`review`/`qa` scope each carrying its attempt allowance and its turn and wall-clock watchdogs.
  `ConstraintKey`, `constraintKeys`, `ExtendConstraintCommand`, and `RetryStageCommand` are retired; `continue`,
  `rerun <target>`, and `resume` replace `extend` and `retry`.
- Events: `attempt_started`, `turn_completed`, and `attempt_ended` are the only additions. Recovery grants ride
  on `attention_cleared` as resolutions, so `rerun` gains an optional target rather than an event of its own.
- Core: the reducer accrues turns and wall clock, owns the exhaustion predicate, and rejects a
  `constraint_exhausted` claim its own accounting does not support. A validated-candidate slot is consumed where
  `pr_ci` passes, which is already a branch the core has.
- Swordfish: evaluate the ledger in the existing heartbeat loop (`apps/swordfish/src/protocol/client.ts`) rather
  than adding a timer, and replace the `constraint_ledger` table, which currently encodes the retired per-key
  model and its incorrect `limit_value + 1` extension.
- Bebop: cross-check elapsed time in the heartbeat handler with a grace margin, reporting a daemon defect rather
  than an exhaustion.

Four things are worth knowing before reading the code.

**The scope is the cowboy.** `attempt_started` carries no payload at all. Ein builds, jet reviews, faye runs QA,
so the active cowboy's role _is_ the constraint scope, the ordinal is the reducer's own count, and the start
instant is the message's `occurredAt`. Every field the event could have declared is one the reducer already
knows and would have had to check — and requiring an active cowboy makes an attempt with no seat unrepresentable
rather than merely invalid.

**Wall clock is accrued, not subtracted.** An attempt holds elapsed milliseconds plus a running-since mark, and
`applyWorkflowEvent` folds the interval in before interpreting each event and re-marks after. That ordering is
what charges an interval to the conditions that held during it: a takeover at 12:30 charges everything up to
12:30 and nothing after. It is also what makes daemon downtime count with no timer to have missed it, and what
excludes attention time structurally rather than by rule.

**The profile is state, not a parameter.** It is frozen per bounty and lives in `WorkflowCoreState`, because
Bebop's projection has to reach the same exhaustion verdict from the same events — a limit passed in at each
call site would be a second copy for the two of them to disagree about. Where it is parsed from stays open; both
apps seed it from the built-in default today.

**Two guards are deliberately loud.** A `turn_completed` under human control and a `cowboy_deactivated` with an
attempt still in flight are both illegal transitions rather than silently ignored. Each means the daemon did
something the model says cannot happen, and ADR 0042's whole argument is that one failed transition beats a
budget that quietly stops meaning anything.

The two open questions below are now decided. The first is settled behaviour the ledger inherits.

1. **`reopen-spec` may land in a suspended stage.** ADR 0038 and
   [control lease and takeover](../../docs/capabilities/05-control-lease-and-takeover.md) describe `reopen-spec`
   as a human action that establishes control and carries it into the resulting stage, which reads as though it
   always reaches `implementing`. It does not. A review found that emptying attention on a spec change let
   `reopen-spec` clear reasons whose kind permits no such exit — an unreachable environment or a detected
   intrusion, both of which only `cancel` resolves — so outstanding reasons now survive it. The new spec applies
   and the gates and candidate reset, but the stage stays `needs_attention` with `implementing` recorded as the
   stage to resume into. This matters here because ticket 09 makes `reopen-spec` the only way to earn a fresh
   validated-candidate allowance: the allowance is created by the spec revision, not by the stage resuming, and
   the ledger must not wait on a stage that is still suspended behind an unrelated reason.
2. **How a targeted `rerun` names the record it resolves.** Decided by
   [A rerun resolves the kind its target names (ADR 0043)](../../docs/adr/0043-a-rerun-resolves-the-kind-its-target-names.md):
   the target picks the record, because `validation` is the only deterministic operation a human reruns and an
   uncertain _seat_ is a separate kind permitting no rerun at all — so the map from target to kind is total.
   Having `attention_cleared` name the kind directly was rejected as strictly worse: it admits an inconsistent
   pair the reducer would then have to reject.
3. **Where the frozen profile lives.** Still open, and still fog on [the map](../bebop-mvp/map.md) under
   "Repository configuration in practice". The ledger is built against the profile as a value in
   `WorkflowCoreState`, seeded at construction from the built-in default, so parsing `.bebop/config.yml` later is
   one argument to `initialWorkflowCoreState` rather than a change to the model.

**Not in scope.** The `sf` command surface and its operator credential, plugin intrusion detection, tmux cockpit
layout, and the runtime manifest. Those are separate efforts that consume this model.

## Testing

Bebop's component suites skip unless `BEBOP_TEST_DATABASE_URL` is set, so a green `vp run ready` on a machine
without one proves less than it appears to — a stale gateway fixture survived the first PR's local gate and
failed in CI. Run with the database:

```
docker compose up -d --wait postgres
export BEBOP_TEST_DATABASE_URL=postgres://bebop:bebop@127.0.0.1:5433/bebop
vp run ready
```

The full suite is 38 files with nothing skipped. The ledger touches the projection and the gateway, so those are
exactly the suites that matter here.

## Done when

**Second PR.**

- an attempt consumes its scope's slot before the first prompt, and a slot beyond the allowance is refused,
  proven by test;
- turns and wall clock accrue only while an attempt is active, Swordfish is driving, and the work is not
  suspended, proven by test;
- a `constraint_exhausted` claim the reducer's own arithmetic does not support is refused, proven by test;
- `continue` resets both watchdogs on the suspended attempt, `rerun <target>` grants one attempt in the scope its
  target names and abandons the suspended one, and `resume` grants nothing;
- a `rerun` clears only the record its target addresses, proven by test;
- building's ledger resets at a build-cycle boundary and not at a CI failure; review and qa reset per candidate;
  a spec revision resets all three and the validated-candidate allowance;
- the ledger survives restart, because it is in the workflow snapshot rather than a table beside it;
- Swordfish evaluates the ledger on the heartbeat it already sends, and Bebop reports a silent overrun as a
  daemon defect rather than as an exhaustion.

**First PR.**

- `needs_attention` is the only suspending stage besides `cancelling`, and no stage means "a human is driving";
- a `code_review` gate cannot be recorded for a candidate whose `pr_ci` gate has not passed, proven by test;
- at most one cowboy is active in every reachable state, proven by test;
- every attention record names the actions that clear it, and a resolution not on that list is refused;
- takeover and handoff change `controller` and leave `stage` and `suspendedStage` untouched;
- `deriveBountyStatus` reports `human_controlled` from the controller and `needs_attention` from the stage;
- the golden protocol fixture and the golden replay transcript both round-trip;
- `vp check` and `vp test` pass from a clean checkout.

## Protocol versioning

The wire protocol is evolved in place rather than versioned to v2. No Swordfish has ever run outside a test —
exe.dev provisioning is still ticket 03 — so there is no deployed peer to stay compatible with, and a v2 that
never had a v1 peer is ceremony. The golden v1 fixture is regenerated to match.
