// The Swordfish workflow transition core (`docs/capabilities/06-autonomous-implementation.md`).
//
// Both Swordfish and Bebop apply the same event stream and must reach the same conclusion
// about stage, gates, candidate, and attention. This module is the single interpretation of
// those events; it is pure, and it knows nothing about SQLite, Postgres, sockets, or
// connection freshness. Bebop's connection and freshness scoping wraps it rather than
// re-implementing it, because that scoping is Bebop's genuinely distinct concern.
//
// Before this package existed the two copies had already drifted: Swordfish recorded
// `attentionReason` from a `stage_changed -> needs_attention` event and Bebop did not, so a
// bounty could report `needs_attention` to the CLI with a blank reason.

import { createHash } from "node:crypto";

import type {
  AttentionKind,
  CandidateGate,
  ConstraintScope,
  EventMessage,
  SeatRole,
  SwordfishStage,
} from "@bebop/contracts";
import {
  constraintScopeForRole,
  EventMessage as EventMessageSchema,
  kindForRerunTarget,
  resolutionsForAttention,
  scopeForRerunTarget,
  toEventSequence,
} from "@bebop/contracts";
import { Schema } from "effect";

import {
  accrueAttemptClock,
  attemptBudget,
  attemptsAllowed,
  exhaustedConstraints,
  markAttemptClock,
  watchdogGrant,
} from "#src/ledger.ts";
import {
  fingerprintWindow,
  initialGates,
  isSuspended,
  isTerminal,
  resetScopes,
  type AttemptState,
  type AttentionState,
  type GateStates,
  type WorkflowCoreState,
} from "#src/state.ts";

export type WorkflowError =
  | { readonly type: "sequence_gap"; readonly expected: number; readonly received: number }
  | { readonly type: "sequence_collision"; readonly sequence: number }
  | { readonly type: "fingerprint_missing"; readonly sequence: number; readonly floor: number }
  | { readonly type: "illegal_transition"; readonly stage: SwordfishStage | null; readonly eventType: string }
  | { readonly type: "spec_revision_mismatch"; readonly expected: number; readonly received: number }
  | { readonly type: "candidate_mismatch"; readonly expectedSha: string | null; readonly receivedSha: string }
  | { readonly type: "gate_not_pending"; readonly gate: string; readonly status: string }
  | { readonly type: "gate_out_of_order"; readonly gate: CandidateGate; readonly blockedBy: CandidateGate }
  | { readonly type: "cowboy_already_active"; readonly active: SeatRole; readonly requested: SeatRole }
  | { readonly type: "cowboy_not_active"; readonly requested: SeatRole }
  | { readonly type: "no_attention_raised" }
  | { readonly type: "resolution_not_permitted"; readonly kind: AttentionKind; readonly resolution: string }
  | { readonly type: "attention_kind_not_raised"; readonly kind: AttentionKind }
  | { readonly type: "attempt_already_active"; readonly scope: ConstraintScope; readonly ordinal: number }
  | { readonly type: "attempt_not_active"; readonly eventType: string }
  | {
      readonly type: "attempts_exhausted";
      readonly scope: ConstraintScope;
      readonly consumed: number;
      readonly allowed: number;
    }
  | { readonly type: "validated_candidates_exhausted"; readonly consumed: number; readonly allowed: number }
  /**
   * The daemon claimed a budget ran out and the reducer's own arithmetic disagrees
   * ("Constraint exhaustion is computed, not announced" (ADR 0042)).
   */
  | { readonly type: "exhaustion_unsupported"; readonly claim: string };

/**
 * Why an event changed nothing. The distinction is load-bearing rather than diagnostic: it
 * is what tells a gateway whether it may acknowledge.
 *
 * - `already_applied` — seen before, verified identical. Safe to acknowledge; not
 *   acknowledging it loops replay forever.
 * - `unverifiable_replay` — at or below the applied frontier but its fingerprint has been
 *   pruned, so identity could not be confirmed. Still safe to acknowledge, because the
 *   sequence is behind the frontier, but the caller knows the check did not run.
 */
export type WorkflowSkipReason = "already_applied" | "unverifiable_replay";

export type WorkflowResult<S> =
  | { readonly ok: true; readonly applied: true; readonly state: S }
  | { readonly ok: true; readonly applied: false; readonly reason: WorkflowSkipReason; readonly state: S }
  | { readonly ok: false; readonly error: WorkflowError };

/**
 * A short content hash of the encoded event.
 *
 * The previous implementation retained the complete re-encoded JSON of every event, so a
 * long bounty stored each event twice in durable state. Only identity is ever compared, so
 * a hash carries the whole signal at a fixed 32 bytes.
 */
export function eventFingerprint(message: EventMessage): string {
  const encoded = JSON.stringify(Schema.encodeSync(EventMessageSchema)(message));
  return createHash("sha256").update(encoded).digest("hex").slice(0, 32);
}

function stageChanges(state: WorkflowCoreState, nextStage: SwordfishStage): Partial<WorkflowCoreState> {
  return isSuspended(state.stage) ? { suspendedStage: nextStage } : { stage: nextStage };
}

/**
 * The gate that must pass before `gate` may be recorded at all.
 *
 * "CI gates cowboy review" (ADR 0040) replaced a parallel join with an order: a candidate passes local
 * validation, is pushed, receives a polled CI result, and only then enters review. Encoding that as a
 * prerequisite rather than as stage arithmetic is what makes the rule enforceable — the previous model computed
 * a stage from whichever gates happened to have landed, so a `code_review` result arriving before CI was
 * accepted and simply produced a different stage.
 */
const gatePrerequisite: Readonly<Partial<Record<CandidateGate, CandidateGate>>> = {
  pr_ci: "local_validation",
  code_review: "pr_ci",
  qa: "code_review",
  evidence_upload: "qa",
};

/** The stage a candidate sits in once `gates` have landed, given that gates land in order. */
function gateStage(gates: GateStates): SwordfishStage {
  if (gates.pr_ci.status === "failed" || gates.code_review.status === "failed") {
    return "revision";
  }
  if (gates.code_review.status === "passed") {
    return "qa_preparing";
  }
  if (gates.pr_ci.status === "passed") {
    return "code_review";
  }
  return "pushed_candidate";
}

function illegal(state: WorkflowCoreState, eventType: string): WorkflowError {
  return { type: "illegal_transition", stage: state.stage, eventType };
}

/**
 * Computes the core field changes for one event, or the error that rejects it.
 *
 * Returning changes rather than a whole state is what lets both apps keep their own extra
 * fields without either of them re-deciding what an event means.
 */
function changesFor(
  state: WorkflowCoreState,
  message: EventMessage,
):
  | { readonly ok: true; readonly changes: Partial<WorkflowCoreState> }
  | { readonly ok: false; readonly error: WorkflowError } {
  const event = message.event;

  switch (event.type) {
    case "effective_spec_set": {
      // Bebop's projection may still be at `null` because it has not heard from this
      // Swordfish yet; Swordfish itself is at `interactive`.
      //
      // A human under control may reopen the spec from any stage: `reopen-spec` is a named workflow action
      // ("Workflow actions have role-aware adapters" (ADR 0038)) and control follows it into the resulting
      // stage. Swordfish may not, because an autonomous rewrite of the spec mid-run is exactly the drift the
      // effective spec exists to prevent.
      const reopenable = state.stage === null || state.stage === "interactive" || state.controller === "human";
      if (!reopenable) {
        return { ok: false, error: illegal(state, event.type) };
      }
      const expected = (state.effectiveSpec?.revision ?? 0) + 1;
      if (event.spec.revision !== expected) {
        return {
          ok: false,
          error: { type: "spec_revision_mismatch", expected, received: event.spec.revision },
        };
      }
      // A new spec resets every constraint ledger, so any constraint attention against the old spec is obsolete.
      // It does not answer an unreachable VM or an intrusion, though: unrelated reasons survive and keep the
      // workflow suspended rather than letting `reopen-spec` bypass their permitted resolutions.
      const attention = state.attention.filter((record) => record.kind !== "constraint_exhausted");
      const suspended = attention.length > 0;
      return {
        ok: true,
        changes: {
          stage: suspended ? "needs_attention" : "implementing",
          suspendedStage: suspended ? "implementing" : null,
          attention,
          effectiveSpec: event.spec,
          candidate: null,
          gates: initialGates(),
          readinessClaim: null,
          // A confirmed spec revision is the one thing that creates a fresh validated-candidate allowance, and it
          // creates fresh scoped attempt ledgers with it. The allowance is earned by the revision, not by the
          // stage resuming — an outstanding intrusion keeps the bounty suspended above, and the ledger must not
          // wait on a stage that is stopped for a reason the spec change did not answer.
          ledgers: resetScopes(state.ledgers, ["building", "review", "qa"]),
          validatedCandidatesConsumed: 0,
          // A suspended attempt against the previous spec has nothing left to do.
          attempt: null,
        },
      };
    }

    case "candidate_submitted": {
      if (state.stage !== "implementing" && state.stage !== "revision") {
        return { ok: false, error: illegal(state, event.type) };
      }
      const allowed = state.constraints.validatedCandidatesPerSpec;
      if (state.validatedCandidatesConsumed >= allowed) {
        return {
          ok: false,
          error: {
            type: "validated_candidates_exhausted",
            consumed: state.validatedCandidatesConsumed,
            allowed,
          },
        };
      }
      if (state.effectiveSpec === null || event.candidate.specRevision !== state.effectiveSpec.revision) {
        return {
          ok: false,
          error: {
            type: "spec_revision_mismatch",
            expected: state.effectiveSpec?.revision ?? 0,
            received: event.candidate.specRevision,
          },
        };
      }
      return {
        ok: true,
        changes: {
          stage: "local_validation",
          candidate: event.candidate,
          gates: { ...initialGates(), local_validation: { status: "pending" } },
          readinessClaim: null,
          // Jet and faye are allowed attempts *per candidate*, so a new candidate is where those two ledgers
          // reset. Building's is not: a candidate that fails local validation or CI returns feedback to ein
          // inside the same build cycle, and resetting here would give ein an unbounded supply of attempts by
          // the simple expedient of submitting something that fails.
          ledgers: resetScopes(state.ledgers, ["review", "qa"]),
        },
      };
    }

    case "gate_completed": {
      if (state.candidate === null || state.candidate.commitSha !== event.candidateSha) {
        return {
          ok: false,
          error: {
            type: "candidate_mismatch",
            expectedSha: state.candidate?.commitSha ?? null,
            receivedSha: event.candidateSha,
          },
        };
      }
      if (state.candidate.specRevision !== event.specRevision) {
        return {
          ok: false,
          error: {
            type: "spec_revision_mismatch",
            expected: state.candidate.specRevision,
            received: event.specRevision,
          },
        };
      }
      const current = state.gates[event.gate];
      if (current.status !== "pending") {
        return { ok: false, error: { type: "gate_not_pending", gate: event.gate, status: current.status } };
      }
      // The gate order is a rule about what may be claimed, not a stage computation. A `code_review` result for
      // a candidate whose CI has not passed means jet ran when it should not have, and recording it would make
      // the validated-candidate allowance describe SHAs that never reached CI ("CI gates cowboy review"
      // (ADR 0040)).
      const prerequisite = gatePrerequisite[event.gate];
      if (prerequisite !== undefined && state.gates[prerequisite].status !== "passed") {
        return { ok: false, error: { type: "gate_out_of_order", gate: event.gate, blockedBy: prerequisite } };
      }
      const gates: GateStates = {
        ...state.gates,
        [event.gate]: { status: event.outcome, completedAt: message.occurredAt },
      };
      if (event.outcome === "failed") {
        // A blocking review or QA result is a valid role completion that starts a *new* ein build cycle, so
        // building's attempt ledger resets. A local-validation or CI failure is feedback inside the current
        // cycle and deliberately does not reset it: those are exactly the loops the three-attempt allowance
        // exists to bound.
        const endsBuildCycle = event.gate === "code_review" || event.gate === "qa";
        return {
          ok: true,
          changes: {
            gates,
            ...stageChanges(state, "revision"),
            readinessClaim: null,
            ...(endsBuildCycle ? { ledgers: resetScopes(state.ledgers, ["building"]) } : {}),
          },
        };
      }
      if (event.gate === "local_validation") {
        return { ok: true, changes: { gates } };
      }
      // Passing CI is what opens review, so the review gate becomes claimable here rather than when the
      // candidate was pushed. That is the whole of ADR 0040 in the state model: before this, both gates were
      // opened together at push time and either could land first.
      if (event.gate === "pr_ci") {
        return {
          ok: true,
          changes: {
            gates: { ...gates, code_review: { status: "pending" } },
            ...stageChanges(state, gateStage(gates)),
            // Passing CI is what makes a candidate a *validated* candidate, so this is where one of the spec's
            // slots is spent. It is charged once per candidate that reaches here, under either controller: the
            // allowance bounds how many distinct SHAs a spec may put in front of a reviewer, and who produced
            // them does not change that (`.scratch/bebop-mvp/issues/09-default-constraints-and-exhaustion.md`).
            validatedCandidatesConsumed: state.validatedCandidatesConsumed + 1,
          },
        };
      }
      if (event.gate === "code_review") {
        return { ok: true, changes: { gates, ...stageChanges(state, gateStage(gates)) } };
      }
      if (event.gate === "qa") {
        return {
          ok: true,
          changes: {
            gates: { ...gates, evidence_upload: { status: "pending" } },
            ...stageChanges(state, "evidence_upload"),
          },
        };
      }
      return {
        ok: true,
        changes: {
          gates,
          ...stageChanges(state, "ready"),
          readinessClaim: { candidateSha: event.candidateSha, specRevision: event.specRevision },
        },
      };
    }

    case "candidate_invalidated": {
      if (state.candidate === null || state.candidate.commitSha !== event.candidateSha) {
        return {
          ok: false,
          error: {
            type: "candidate_mismatch",
            expectedSha: state.candidate?.commitSha ?? null,
            receivedSha: event.candidateSha,
          },
        };
      }
      if (state.candidate.specRevision !== event.specRevision) {
        return {
          ok: false,
          error: {
            type: "spec_revision_mismatch",
            expected: state.candidate.specRevision,
            received: event.specRevision,
          },
        };
      }
      return {
        ok: true,
        changes: {
          ...stageChanges(state, "revision"),
          candidate: null,
          gates: initialGates(),
          readinessClaim: null,
        },
      };
    }

    case "stage_changed": {
      // The first event is Swordfish announcing its initial state. Swordfish starts at
      // `interactive`, while Bebop's projection starts at null; accepting the announcement
      // in both states lets the same durable event pass through both reducers.
      if (
        event.stage === "interactive" &&
        (state.stage === null || (state.stage === "interactive" && state.lastAppliedSequence === 0))
      ) {
        return { ok: true, changes: { stage: "interactive" } };
      }
      if (event.stage === "pushed_candidate") {
        // Only CI is opened here. Review opens when CI passes (ADR 0040).
        return state.stage === "local_validation" && state.gates.local_validation.status === "passed"
          ? {
              ok: true,
              changes: {
                stage: "pushed_candidate",
                gates: { ...state.gates, pr_ci: { status: "pending" } },
              },
            }
          : { ok: false, error: illegal(state, event.type) };
      }
      if (event.stage === "qa_running") {
        return state.stage === "qa_preparing"
          ? { ok: true, changes: { stage: "qa_running", gates: { ...state.gates, qa: { status: "pending" } } } }
          : { ok: false, error: illegal(state, event.type) };
      }
      if (event.stage === "cancelling" && !isTerminal(state.stage)) {
        return { ok: true, changes: { stage: "cancelling" } };
      }
      // Terminal transitions stand the active cowboy down. Nothing is driving a bounty whose loop has ended, and
      // this is the last chance to say so: `applyWorkflowEvent` refuses every event once the stage is terminal,
      // so a later `cowboy_deactivated` cannot repair it and status would mark a seat active forever.
      if (event.stage === "cancelled" && state.stage === "cancelling") {
        return {
          ok: true,
          changes: { stage: "cancelled", suspendedStage: null, attention: [], activeCowboy: null, attempt: null },
        };
      }
      if (event.stage === "failed" && state.stage !== "cancelled") {
        return {
          ok: true,
          changes: { stage: "failed", suspendedStage: null, attention: [], activeCowboy: null, attempt: null },
        };
      }
      // `needs_attention` is deliberately unreachable here: it is entered by `attention_required` and left by
      // `attention_cleared`, so every suspension carries a reason and every resumption names the action that
      // earned it. A bare stage change into attention could do neither.
      return { ok: false, error: illegal(state, event.type) };
    }

    case "control_changed": {
      if (isTerminal(state.stage)) {
        return { ok: false, error: illegal(state, event.type) };
      }
      // Takeover needs something to take over. Attention establishes human control without one, because the
      // bounty has already stopped and a human arriving to inspect it is the point (ADR 0037).
      if (
        (event.reason === "takeover" || event.reason === "forced_takeover") &&
        state.activeCowboy === null &&
        state.controller !== "human"
      ) {
        return { ok: false, error: illegal(state, event.type) };
      }
      if (event.reason === "handoff" && state.controller !== "human") {
        return { ok: false, error: illegal(state, event.type) };
      }
      // Stage is untouched on purpose: a handoff returns the same work to Swordfish, which then starts fresh
      // work for that stage rather than resuming an aborted turn ("Control passes through a quiescent handoff"
      // (ADR 0036)).
      //
      // The attempt is not untouched, and the asymmetry is the point. Taking over stops the autonomous clock
      // without refunding the attempt that started, so the attempt survives and simply stops accruing — that
      // falls out of `clockRuns` with nothing recorded here. Handing back starts a *new* attempt and consumes
      // its next slot (ADR 0041), so the old one ends here; leaving it would let the returning `attempt_started`
      // be rejected for an attempt already active and would restart a clock that belongs to work nobody is
      // doing.
      return {
        ok: true,
        changes: { controller: event.controller, ...(event.reason === "handoff" ? { attempt: null } : {}) },
      };
    }

    case "cowboy_activated": {
      if (isTerminal(state.stage)) {
        return { ok: false, error: illegal(state, event.type) };
      }
      const active = state.activeCowboy;
      // Re-announcing the seat already active is how ein's durable seat is reused across attempts; a *different*
      // seat while one is active would be a second concurrent cowboy, which is the thing ADR 0037 forbids.
      if (active !== null && active.seatId !== event.seatId) {
        return { ok: false, error: { type: "cowboy_already_active", active: active.role, requested: event.seat } };
      }
      // A seat belongs to one cowboy for its whole life, so the same ID arriving under a different role is a
      // defect rather than a reassignment. Accepting it would leave the reducer's role disagreeing with the one
      // already recorded against that seat ID in Swordfish's seat table.
      if (active !== null && active.role !== event.seat) {
        return { ok: false, error: { type: "cowboy_already_active", active: active.role, requested: event.seat } };
      }
      return { ok: true, changes: { activeCowboy: { role: event.seat, seatId: event.seatId } } };
    }

    case "cowboy_deactivated": {
      const active = state.activeCowboy;
      // Matching the seat ID, not just the role, is what stops a late deactivation from a finished jet attempt
      // retiring the fresh jet seat that replaced it.
      if (active === null || active.role !== event.seat || active.seatId !== event.seatId) {
        return { ok: false, error: { type: "cowboy_not_active", requested: event.seat } };
      }
      // An attempt is one cowboy assignment, so standing the cowboy down while one is in flight would leave an
      // attempt whose seat no longer exists — accruing wall clock against nobody. The attempt ends first.
      if (state.attempt !== null) {
        return {
          ok: false,
          error: { type: "attempt_already_active", scope: state.attempt.scope, ordinal: state.attempt.ordinal },
        };
      }
      return { ok: true, changes: { activeCowboy: null } };
    }

    case "attempt_started": {
      const cowboy = state.activeCowboy;
      // An attempt is one Swordfish-controlled cowboy assignment: no cowboy and no Swordfish control both mean
      // there is no attempt to be had. Human-controlled work is unconstrained and deliberately unmeasured.
      if (cowboy === null || state.controller !== "swordfish" || isSuspended(state.stage)) {
        return { ok: false, error: illegal(state, event.type) };
      }
      if (state.attempt !== null) {
        return {
          ok: false,
          error: { type: "attempt_already_active", scope: state.attempt.scope, ordinal: state.attempt.ordinal },
        };
      }
      // The slot is consumed here, before the first prompt, and the reducer owns whether one is available. A
      // daemon that starts a fourth attempt against a three-attempt allowance is not granted a fourth — a grant
      // is a human `rerun`, and this is the transition that says so.
      const scope = constraintScopeForRole[cowboy.role];
      const consumed = state.ledgers[scope].attemptsConsumed;
      const allowed = attemptsAllowed(state, scope);
      if (consumed >= allowed) {
        return { ok: false, error: { type: "attempts_exhausted", scope, consumed, allowed } };
      }
      const attempt: AttemptState = {
        scope,
        role: cowboy.role,
        seatId: cowboy.seatId,
        ordinal: consumed + 1,
        startedAt: message.occurredAt,
        turns: 0,
        turnsGranted: 0,
        elapsedMs: 0,
        wallClockGrantedMs: 0,
        // Left stopped here and started by `markAttemptClock` once the whole event has applied, so one rule
        // decides when the clock runs rather than each site that touches an attempt.
        runningSince: null,
      };
      return {
        ok: true,
        changes: {
          attempt,
          ledgers: { ...state.ledgers, [scope]: { ...state.ledgers[scope], attemptsConsumed: consumed + 1 } },
        },
      };
    }

    case "turn_completed": {
      const attempt = state.attempt;
      if (attempt === null) {
        return { ok: false, error: { type: "attempt_not_active", eventType: event.type } };
      }
      // Turns are only counted while Swordfish is driving and the work is running. A turn reported under human
      // control or against a suspended stage means the daemon kept prompting after it gave up control or
      // stopped, which is a defect worth one loud failure rather than a silently uncounted turn.
      if (state.controller !== "swordfish" || isSuspended(state.stage)) {
        return { ok: false, error: illegal(state, event.type) };
      }
      return { ok: true, changes: { attempt: { ...attempt, turns: attempt.turns + 1 } } };
    }

    case "attempt_ended": {
      const attempt = state.attempt;
      if (attempt === null) {
        return { ok: false, error: { type: "attempt_not_active", eventType: event.type } };
      }
      // The one claim in this event that the reducer can check, and therefore does. `no_result` covers an idle
      // or seat-local failure and asserts nothing about a budget; `exhausted` asserts that this attempt's
      // watchdogs ran out, and the arithmetic above is what decides that (ADR 0042).
      if (event.outcome === "exhausted") {
        const budget = attemptBudget(state, attempt);
        if (attempt.turns < budget.turns && attempt.elapsedMs < budget.wallClockMs) {
          return {
            ok: false,
            error: {
              type: "exhaustion_unsupported",
              claim: `attempt ${attempt.ordinal} in ${attempt.scope} is at ${attempt.turns}/${budget.turns} turns and ${attempt.elapsedMs}/${budget.wallClockMs}ms`,
            },
          };
        }
      }
      return { ok: true, changes: { attempt: null } };
    }

    case "attachments_updated":
      return { ok: true, changes: { previews: event.previews } };

    case "attention_required": {
      // The one attention kind that is an arithmetic claim rather than an observation. Everything else Swordfish
      // raises is something only it can see — a wedged process, an unreachable VM, an agent saying it is stuck.
      // A budget is not: the reducer has every event and every timestamp, so a daemon whose watchdog fires
      // against accounting that says the attempt is still within budget has a bug, and this is where that bug
      // becomes visible instead of a silently strangled attempt (ADR 0042).
      if (event.kind === "constraint_exhausted" && exhaustedConstraints(state).length === 0) {
        const attempt = state.attempt;
        return {
          ok: false,
          error: {
            type: "exhaustion_unsupported",
            claim:
              attempt === null
                ? "no attempt is active and every scoped allowance has slots remaining"
                : `attempt ${attempt.ordinal} in ${attempt.scope} is at ${attempt.turns} turns and ${attempt.elapsedMs}ms`,
          },
        };
      }
      const raised = { kind: event.kind, reason: event.reason, raisedAt: message.occurredAt };
      // Reasons accumulate rather than replacing each other, so a later laxer reason cannot widen the exits of
      // an outstanding stricter one. A second reason of the same kind is a restatement and replaces it.
      const attention = [...state.attention.filter((record) => record.kind !== event.kind), raised];
      // Already suspended: record the reason but keep the stage that was interrupted. An attention raised while
      // cancelling must not rewrite the cancellation as something resumable.
      if (isSuspended(state.stage)) {
        return { ok: true, changes: { attention } };
      }
      return {
        ok: true,
        changes: {
          stage: "needs_attention",
          suspendedStage: state.stage ?? "interactive",
          attention,
        },
      };
    }

    case "attention_cleared": {
      if (state.attention.length === 0) {
        return { ok: false, error: { type: "no_attention_raised" } };
      }
      // A `rerun` addresses exactly the one record its target names, and nothing else. Every other resolution
      // clears every outstanding reason that permits it, and only those — which is the rule that makes an
      // attention kind mean something: `resume` cannot clear an exhausted budget, because reviving an attempt is
      // a grant and grants are explicit (ADR 0038, ADR 0041). It is also why reasons are a list: a `resume`
      // arriving while both an operational reason and an exhausted budget are outstanding clears the operational
      // one and leaves the budget suspended, rather than reviving work nobody granted.
      //
      // `rerun` is the exception because it is the resolution that carries a grant. Two kinds permit it, and
      // granting an ein attempt is no answer at all to a gate whose outcome is unknown, so the target picks the
      // record ("A rerun resolves the kind its target names" (ADR 0043)).
      const targetKind = event.target === undefined ? null : kindForRerunTarget[event.target];
      if (event.resolution === "rerun" && targetKind === null) {
        return { ok: false, error: illegal(state, event.type) };
      }
      const addressed = (record: AttentionState): boolean => {
        const permitted: ReadonlyArray<string> = resolutionsForAttention[record.kind];
        if (!permitted.includes(event.resolution)) return false;
        return targetKind === null || record.kind === targetKind;
      };

      const cleared = state.attention.filter((record) => !addressed(record));
      const outstanding = state.attention[0];
      if (outstanding !== undefined && cleared.length === state.attention.length) {
        return targetKind === null
          ? {
              ok: false,
              error: { type: "resolution_not_permitted", kind: outstanding.kind, resolution: event.resolution },
            }
          : { ok: false, error: { type: "attention_kind_not_raised", kind: targetKind } };
      }

      // Recovery grants are what these two resolutions *are*, so they are applied in the same transition that
      // clears the reason rather than announced by an event of their own (ADR 0042). Both are unlimited and
      // neither is implicit: every one of them is an authenticated human command that leaves a durable record.
      let grants: Partial<WorkflowCoreState> = {};
      if (event.resolution === "continue") {
        const attempt = state.attempt;
        // `continue` revives a suspended attempt. With nothing suspended there is nothing to revive, and what
        // the operator wants is `rerun` — the two are distinct verbs precisely so this cannot be guessed at.
        if (attempt === null) {
          return { ok: false, error: { type: "attempt_not_active", eventType: event.type } };
        }
        const grant = watchdogGrant(state, attempt.scope);
        grants = {
          attempt: {
            ...attempt,
            turnsGranted: attempt.turnsGranted + grant.turns,
            wallClockGrantedMs: attempt.wallClockGrantedMs + grant.wallClockMs,
          },
        };
      } else if (event.target !== undefined) {
        const scope = scopeForRerunTarget(event.target);
        // `rerun validation` repeats a deterministic operation against the same SHA. It grants no attempt and
        // abandons none, because no cowboy attempt was ever involved in the gate it reruns.
        if (scope !== null) {
          const ledger = state.ledgers[scope];
          grants = {
            ledgers: { ...state.ledgers, [scope]: { ...ledger, attemptsGranted: ledger.attemptsGranted + 1 } },
            attempt: null,
          };
        }
      }

      // The workflow resumes only once nothing is outstanding, and clearing a reason raised during cancellation
      // never revives the run.
      if (cleared.length > 0 || state.stage !== "needs_attention") {
        return { ok: true, changes: { ...grants, attention: cleared } };
      }
      return {
        ok: true,
        changes: {
          ...grants,
          stage: state.suspendedStage ?? "interactive",
          suspendedStage: null,
          attention: cleared,
        },
      };
    }
  }
}

/** Retains fingerprints only for the window still reachable by replay. */
function pruneFingerprints(
  fingerprints: Readonly<Record<number, string>>,
  appliedSequence: number,
): { readonly retained: Record<number, string>; readonly floor: number } {
  const floor = Math.max(1, appliedSequence - fingerprintWindow + 1);
  const retained: Record<number, string> = {};
  for (const [key, value] of Object.entries(fingerprints)) {
    if (Number(key) >= floor) {
      retained[Number(key)] = value;
    }
  }
  return { retained, floor };
}

/**
 * Applies one event to any state that carries the core fields.
 *
 * The generic parameter is what lets Bebop keep `connectionId`, `freshness`, and
 * `lastProducedSequence` on the same value the core updates, without the core knowing they
 * exist.
 */
export function applyWorkflowEvent<S extends WorkflowCoreState>(state: S, message: EventMessage): WorkflowResult<S> {
  const retained = state.appliedEventFingerprints[message.sequence];
  if (retained !== undefined && retained !== eventFingerprint(message)) {
    return { ok: false, error: { type: "sequence_collision", sequence: message.sequence } };
  }

  if (message.sequence <= state.lastAppliedSequence) {
    if (retained !== undefined) {
      return { ok: true, applied: false, reason: "already_applied", state };
    }
    // Below the retention floor the identity check cannot run. That is a deliberate,
    // bounded weakening and the caller is told about it; inside the window a missing
    // fingerprint means the state itself is inconsistent, which is not.
    return message.sequence < state.fingerprintFloor
      ? { ok: true, applied: false, reason: "unverifiable_replay", state }
      : {
          ok: false,
          error: { type: "fingerprint_missing", sequence: message.sequence, floor: state.fingerprintFloor },
        };
  }

  const expected = state.lastAppliedSequence + 1;
  if (message.sequence !== expected) {
    return { ok: false, error: { type: "sequence_gap", expected, received: message.sequence } };
  }
  if (isTerminal(state.stage)) {
    return { ok: false, error: illegal(state, message.event.type) };
  }

  // Wall clock is folded in before the event is interpreted and re-marked after, so every rule reads an attempt
  // that is already accurate as of this instant and no rule has to remember to advance it. That ordering is what
  // charges the interval to the conditions that held *during* it: a takeover charges everything up to the
  // takeover and nothing after, and an exhaustion check sees the time that had actually elapsed when the daemon
  // claimed it (ADR 0042).
  const accrued = accrueAttemptClock(state, message.occurredAt);
  const outcome = changesFor(accrued, message);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }

  const { retained: fingerprints, floor } = pruneFingerprints(
    { ...state.appliedEventFingerprints, [message.sequence]: eventFingerprint(message) },
    message.sequence,
  );

  // The core writes only core fields, and never writes null to `stage`, so an app that
  // narrows `stage` to non-null keeps that guarantee. TypeScript cannot see this because
  // the core's own `stage` is the wider nullable type.
  const applied = {
    ...accrued,
    ...outcome.changes,
    lastAppliedSequence: toEventSequence(message.sequence),
    appliedEventFingerprints: fingerprints,
    fingerprintFloor: floor,
  } as unknown as S;

  return { ok: true, applied: true, state: markAttemptClock(applied, message.occurredAt) };
}
