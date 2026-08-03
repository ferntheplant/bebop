# What are the default constraints, and what happens when one is exhausted?

Type: grilling
Status: resolved

## Question

The provisional profile, adopted as a recommended default and never reviewed:

```yaml
constraints:
  primary:
    maxTurnsPerAttempt: 40
    maxWallClockMinutesPerAttempt: 90
  review:
    maxRounds: 3
    maxTurnsPerAttempt: 15
    maxWallClockMinutesPerAttempt: 30
  qa:
    maxRounds: 3
    maxTurnsPerAttempt: 20
    maxWallClockMinutesPerAttempt: 45
```

Swordfish keeps a ledger rather than resetting counters globally: exhaustion enters `needs_attention`, and a
human `resume` grants exactly one more life to the exhausted constraint only.

Settle:

- the actual numbers, and what evidence would justify each — a turn budget picked by feel will either strangle
  legitimate work or fail to catch a loop;
- whether budgets are per stage, per candidate, or per bounty, and how a revision loop accumulates against
  them;
- what "one extra life" means when two constraints are exhausted at once;
- whether cost belongs in the ledger alongside turns and wall-clock, given that token spend per seat is already
  in the observability floor;
- what the user sees at exhaustion, and whether the bounty holds its VM while waiting for a human — a bounty
  parked in `needs_attention` overnight is a running computer.

## Answer

Constraints are scoped circuit breakers rather than one bounty-lifetime counter. A repository owns its profile
in the base revision's `.bebop/config.yml`; Swordfish freezes that profile for the bounty, fills omitted values
from the defaults below, and accepts any positive safe integer without a product ceiling. A candidate change to
the profile cannot enlarge the bounty evaluating it, even after config approval. A new bounty against the
merged base sees the new profile.

The settled default shape is:

```yaml
constraints:
  validatedCandidatesPerSpec: 3
  building:
    attemptsPerCycle: 3
    turnsPerAttempt: 40
    wallClockMinutesPerAttempt: 90
  review:
    attemptsPerCandidate: 2
    turnsPerAttempt: 15
    wallClockMinutesPerAttempt: 30
  qa:
    attemptsPerCandidate: 2
    turnsPerAttempt: 20
    wallClockMinutesPerAttempt: 45
```

Human-guided spec creation is unconstrained. Confirming a spec establishes its validated-candidate allowance;
autonomous attempt clocks begin only after handoff gives Swordfish control.

### Candidates, build cycles, and gate order

A build cycle begins when ein receives a confirmed spec or downstream feedback and ends when one candidate
passes local validation and external CI. Each accepted `candidate-ready` submission ends one ein attempt and
runs exactly one authoritative local validation operation. A clean local failure or CI failure returns feedback
to ein and consumes that attempt, but neither consumes the effective spec's validated-candidate allowance.
Deterministic validation is never automatically retried; an uncertain operation requires human
`rerun validation` against the same SHA.

CI now gates cowboy review rather than running beside it. After local validation, the candidate is pushed and CI
is polled. A CI-passed candidate becomes a **validated candidate**, consumes one of the spec's three slots, and
only then activates jet. Jet must pass before faye starts QA. A valid blocking review or QA result completes that
gate and starts a new ein build cycle; it is not a no-result attempt eligible for automatic retry.

When a rejecting review or QA result uses the final validated-candidate slot, producing a different SHA requires
`reopen-spec`. Confirming the new spec revision creates a fresh allowance and fresh scoped attempt ledgers while
retaining prior history. A human may still `rerun review` or `rerun qa` on the final rejected SHA because that
creates no new validated candidate.

### Attempts, turns, and time

One attempt is one Swordfish-controlled cowboy assignment. Swordfish consumes an attempt slot durably before
the first prompt. A completed model step consumes one turn whether it requests tools or finishes with prose or
a workflow action; provider transport retries and failed requests do not consume turns. Attempt wall clock is
real elapsed time from the first prompt and includes tools, provider retries, idle grace, and daemon downtime
recovered after restart. It pauses in `needs_attention` and excludes human control, deterministic gates, and
external waits.

Ein gets three attempts per build cycle in its durable seat. Jet and faye get two attempts per candidate and a
fresh seat for each. If an attempt produces no valid role completion because it exhausts turns/time, repeatedly
idles, or suffers a seat-local failure, Swordfish starts the next attempt automatically while allowance remains.
Provider-wide outage or uncertain state enters attention directly rather than burning every attempt. `continue`
inside healthy autonomous work remains in the same attempt and grants no budget.

A cowboy's valid `set-blocked` suspends the current attempt. Ordinary `resume` returns to that same attempt with
its remaining turns and time; attention time is excluded. Takeover stops counting autonomous turns/time but does
not refund the attempt already started. Explicit handoff starts a new autonomous attempt and consumes its next
slot. Human-controlled turns are unconstrained, while a validated candidate consumes the spec allowance under
either controller.

### Exhaustion and recovery

When the final allowed attempt exhausts turns or wall clock, Swordfish preserves it in that seat and enters
`needs_attention`. Other no-result failures retain their provenance but may permit only a fresh attempt. Recovery
verbs are intentionally distinct:

- `continue` revives the suspended final attempt and resets both its turn and wall-clock watchdogs;
- `rerun building` adds one ein attempt to the current build cycle and starts it in ein's durable seat;
- `rerun review` or `rerun qa` adds one attempt for that candidate and starts a fresh cowboy seat;
- `rerun validation` repeats the deterministic operation on the same candidate and is not a cowboy attempt;
- `resume` clears only a safe non-budget suspension such as `set-blocked` and changes no allowance;
- `reopen-spec` is the only way to create another validated-candidate allowance after the current spec exhausts
  its three slots.

Human recoveries are not capped. Every `continue` watchdog reset and every extra `rerun` attempt is explicit,
authenticated, durable, and visible in status. This replaces the provisional “one extra life” rule and the
current implementation's incorrect `limit_value + 1` extension for every constraint kind.

At exhaustion, status shows the suspended stage and attention age; role, attempt ordinal, and last outcome;
consumed/base/granted values for attempts, turns, wall clock, and validated candidates; candidate SHA and spec
revision; controller and connection state; and only the valid next commands. The VM and repository services keep
running so the operator can inspect them immediately. Swordfish only quiesces the active attempt and its tracked
operations. exe.dev's public interface currently documents create, delete, restart, and resize but no
disk-preserving stop/resume primitive.

Token use and provider-reported cost are observability fields, not constraints: subscription-backed models do
not provide a comparable timely monetary signal. Defaults are never tuned automatically. After at least 20
terminal bounties and 20 successful attempts per role, a human reviews turn/time distributions, successful
attempt ordinals, validated candidates per spec, and whether `continue` or `rerun` salvaged work. A changed
default remains a reviewed repository/config release.

The command distinction is recorded in
[Continue preserves an attempt; rerun replaces it (ADR 0041)](../../../docs/adr/0041-continue-preserves-an-attempt-rerun-replaces-it.md).
The gate-order tradeoff is recorded in
[CI gates cowboy review (ADR 0040)](../../../docs/adr/0040-ci-gates-cowboy-review.md).
