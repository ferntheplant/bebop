// The constraint arithmetic ("Constraint exhaustion is computed, not announced" (ADR 0042)).
//
// This module owns two things the reducer then applies: how much of an attempt has been consumed, and whether
// anything is over budget. It is separate from `core.ts` because it is the part a daemon is allowed to *ask*
// but never to *assert* — a `constraint_exhausted` claim is checked against `exhaustedConstraints` and rejected
// when the arithmetic here does not support it, so a skewed clock or a miscounting watchdog becomes one loud
// failed transition rather than a strangled healthy attempt.

import type { ConstraintScope, SwordfishStage, Timestamp } from "@bebop/contracts";
import { attemptAllowance, attemptWatchdogs } from "@bebop/contracts";
import { DateTime } from "effect";

import { isSuspended, type AttemptState, type WorkflowCoreState } from "#src/state.ts";

const millisecondsPerMinute = 60_000;

/** One budget that has run out, in the unit its constraint is measured in. */
export interface ConstraintExhaustion {
  readonly constraint: "turns" | "wall_clock" | "attempts" | "validated_candidates";
  /** The scope it was charged against, or null for the spec-wide validated-candidate allowance. */
  readonly scope: ConstraintScope | null;
  readonly consumed: number;
  readonly allowed: number;
}

/** The attempts a scope may still spend: its frozen base plus every explicit `rerun` grant. */
export function attemptsAllowed(state: WorkflowCoreState, scope: ConstraintScope): number {
  return attemptAllowance(state.constraints, scope) + state.ledgers[scope].attemptsGranted;
}

/** One attempt's watchdogs: the scope's frozen base plus every `continue` reset granted to this attempt. */
export function attemptBudget(
  state: WorkflowCoreState,
  attempt: AttemptState,
): { readonly turns: number; readonly wallClockMs: number } {
  const base = attemptWatchdogs(state.constraints, attempt.scope);
  return {
    turns: base.turns + attempt.turnsGranted,
    wallClockMs: base.wallClockMinutes * millisecondsPerMinute + attempt.wallClockGrantedMs,
  };
}

/** One `continue` grant: a full fresh watchdog pair for the scope, never one dimension alone (ADR 0041). */
export function watchdogGrant(
  state: WorkflowCoreState,
  scope: ConstraintScope,
): { readonly turns: number; readonly wallClockMs: number } {
  const base = attemptWatchdogs(state.constraints, scope);
  return { turns: base.turns, wallClockMs: base.wallClockMinutes * millisecondsPerMinute };
}

/**
 * Whether autonomous time is accruing right now.
 *
 * All three conditions are independent dimensions of the same state, which is the whole reason this predicate is
 * expressible: when human control and attention were mutually exclusive stages, a bounty paused for both had no
 * representation and clearing one would have restarted the clock while the other still applied (ADR 0037).
 */
export function clockRuns(state: WorkflowCoreState): boolean {
  return state.attempt !== null && state.controller === "swordfish" && !isSuspended(state.stage);
}

/**
 * Folds the interval since the last event into the attempt's elapsed time and stops the clock.
 *
 * Run before the event is interpreted, so that the time an event *ends* is charged under the conditions that
 * applied while it was running: a takeover at 12:30 charges everything up to 12:30 to the autonomous attempt and
 * nothing after. A clock that is not running contributes nothing, which is how a restart's downtime is charged
 * exactly once — to whichever side of the gap was actually accruing.
 */
export function accrueAttemptClock<S extends WorkflowCoreState>(state: S, at: Timestamp): S {
  const attempt = state.attempt;
  if (attempt === null || attempt.runningSince === null) return state;
  const elapsed = DateTime.toEpochMillis(at) - DateTime.toEpochMillis(attempt.runningSince);
  return {
    ...state,
    // A negative interval means the emitter's clock went backwards between two events. Charging it would credit
    // the attempt time it had already spent, so it contributes nothing and the sequence check stays the place
    // that cares about ordering.
    attempt: { ...attempt, elapsedMs: attempt.elapsedMs + Math.max(0, elapsed), runningSince: null },
  };
}

/** Restarts the clock at `at` if the state that resulted from the event is one that accrues. */
export function markAttemptClock<S extends WorkflowCoreState>(state: S, at: Timestamp): S {
  const attempt = state.attempt;
  if (attempt === null) return state;
  const runningSince = clockRuns(state) ? at : null;
  return runningSince === attempt.runningSince ? state : { ...state, attempt: { ...attempt, runningSince } };
}

/** The stage the workflow is doing or would resume into, which is what a suspended bounty is really at. */
function workingStage(state: WorkflowCoreState): SwordfishStage | null {
  return isSuspended(state.stage) ? state.suspendedStage : state.stage;
}

/**
 * The scope a stage needs a cowboy attempt in, or null where none is owed.
 *
 * Local validation, the CI poll, and evidence upload are deterministic operations with no seat, so they are
 * legitimately null: a bounty waiting on CI is not a bounty out of attempts.
 */
function scopeAwaitingAttempt(stage: SwordfishStage | null): ConstraintScope | null {
  switch (stage) {
    case "implementing":
    case "revision":
      return "building";
    case "code_review":
      return "review";
    case "qa_preparing":
    case "qa_running":
      return "qa";
    default:
      return null;
  }
}

/**
 * Every budget currently over its limit, in the order a human wants to read them.
 *
 * The list is what makes `constraint_exhausted` checkable: a claim is admissible when this is non-empty, and
 * status prints the same entries so the operator sees the arithmetic that stopped the bounty rather than a
 * daemon's assertion that something did.
 */
export function exhaustedConstraints(state: WorkflowCoreState): ReadonlyArray<ConstraintExhaustion> {
  const exhausted: Array<ConstraintExhaustion> = [];
  const attempt = state.attempt;

  if (attempt !== null) {
    const budget = attemptBudget(state, attempt);
    if (attempt.turns >= budget.turns) {
      exhausted.push({ constraint: "turns", scope: attempt.scope, consumed: attempt.turns, allowed: budget.turns });
    }
    if (attempt.elapsedMs >= budget.wallClockMs) {
      exhausted.push({
        constraint: "wall_clock",
        scope: attempt.scope,
        consumed: attempt.elapsedMs,
        allowed: budget.wallClockMs,
      });
    }
  } else {
    // Only the scope the current stage is waiting on, and only with no attempt in flight. A review ledger left at
    // 2/2 after jet passed is spent, not stuck — the bounty has moved on to QA and owes review nothing. And while
    // the final allowed attempt is still running its allowance is fully consumed but nothing is blocked: what is
    // exhausted then is that attempt's watchdogs, above.
    const scope = scopeAwaitingAttempt(workingStage(state));
    if (scope !== null) {
      const allowed = attemptsAllowed(state, scope);
      const consumed = state.ledgers[scope].attemptsConsumed;
      if (consumed >= allowed) {
        exhausted.push({ constraint: "attempts", scope, consumed, allowed });
      }
    }
  }

  // Spec-wide, and only once another SHA is what the workflow needs. Three validated candidates with the third
  // still under review is a healthy bounty; three with a rejecting result in hand is one that cannot legally
  // produce a fourth without `reopen-spec`.
  const allowed = state.constraints.validatedCandidatesPerSpec;
  if (state.validatedCandidatesConsumed >= allowed && workingStage(state) === "revision") {
    exhausted.push({
      constraint: "validated_candidates",
      scope: null,
      consumed: state.validatedCandidatesConsumed,
      allowed,
    });
  }

  return exhausted;
}
