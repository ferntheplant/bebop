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

import type { AttentionKind, CandidateGate, EventMessage, SeatRole, SwordfishStage } from "@bebop/contracts";
import { EventMessage as EventMessageSchema, resolutionsForAttention, toEventSequence } from "@bebop/contracts";
import { Schema } from "effect";

import { fingerprintWindow, initialGates, type GateStates, type WorkflowCoreState } from "#src/state.ts";

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
  | { readonly type: "resolution_not_permitted"; readonly kind: AttentionKind; readonly resolution: string };

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

/**
 * Stages during which the workflow is suspended: progress is recorded as the stage to
 * resume into rather than applied to `stage` directly.
 *
 * `cancelling` is in this set because in-flight hooks and CI polls legitimately land after
 * a stop command. Without it a late `gate_completed` moved a cancelling run to `revision`
 * and the cancellation was lost.
 *
 * Human control is deliberately absent. A human driving a stage is not a suspension of it — that is what
 * `controller` records, orthogonally ("One controller drives one active cowboy" (ADR 0037)) — so work reported
 * during a human-control episode lands on `stage` like any other.
 */
function isSuspended(stage: SwordfishStage | null): boolean {
  return stage === "needs_attention" || stage === "cancelling";
}

function isTerminal(stage: SwordfishStage | null): boolean {
  return stage === "cancelled" || stage === "failed";
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
      return {
        ok: true,
        changes: {
          stage: "implementing",
          suspendedStage: null,
          effectiveSpec: event.spec,
          candidate: null,
          gates: initialGates(),
          readinessClaim: null,
          attention: null,
        },
      };
    }

    case "candidate_submitted": {
      if (state.stage !== "implementing" && state.stage !== "revision") {
        return { ok: false, error: illegal(state, event.type) };
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
        return { ok: true, changes: { gates, ...stageChanges(state, "revision"), readinessClaim: null } };
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
      if (event.stage === "cancelled" && state.stage === "cancelling") {
        return { ok: true, changes: { stage: "cancelled", suspendedStage: null, attention: null } };
      }
      if (event.stage === "failed" && state.stage !== "cancelled") {
        return { ok: true, changes: { stage: "failed", suspendedStage: null, attention: null } };
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
      return { ok: true, changes: { controller: event.controller } };
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
      return { ok: true, changes: { activeCowboy: { role: event.seat, seatId: event.seatId } } };
    }

    case "cowboy_deactivated": {
      const active = state.activeCowboy;
      // Matching the seat ID, not just the role, is what stops a late deactivation from a finished jet attempt
      // retiring the fresh jet seat that replaced it.
      if (active === null || active.role !== event.seat || active.seatId !== event.seatId) {
        return { ok: false, error: { type: "cowboy_not_active", requested: event.seat } };
      }
      return { ok: true, changes: { activeCowboy: null } };
    }

    case "attachments_updated":
      return { ok: true, changes: { previews: event.previews } };

    case "attention_required": {
      const attention = { kind: event.kind, reason: event.reason, raisedAt: message.occurredAt };
      // Already suspended: record the newer reason but keep the stage that was interrupted. An attention raised
      // while cancelling must not rewrite the cancellation as something resumable.
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
      const attention = state.attention;
      if (attention === null) {
        return { ok: false, error: { type: "no_attention_raised" } };
      }
      // This is the rule that makes an attention kind mean something: a `resume` cannot clear an exhausted
      // budget, because reviving an attempt is a grant and grants are explicit (ADR 0038, ADR 0041).
      const permitted: ReadonlyArray<string> = resolutionsForAttention[attention.kind];
      if (!permitted.includes(event.resolution)) {
        return {
          ok: false,
          error: { type: "resolution_not_permitted", kind: attention.kind, resolution: event.resolution },
        };
      }
      // Clearing attention raised during cancellation drops the reason without reviving the run.
      if (state.stage !== "needs_attention") {
        return { ok: true, changes: { attention: null } };
      }
      return {
        ok: true,
        changes: { stage: state.suspendedStage ?? "interactive", suspendedStage: null, attention: null },
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

  const outcome = changesFor(state, message);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }

  const { retained: fingerprints, floor } = pruneFingerprints(
    { ...state.appliedEventFingerprints, [message.sequence]: eventFingerprint(message) },
    message.sequence,
  );

  return {
    ok: true,
    applied: true,
    // The core writes only core fields, and never writes null to `stage`, so an app that
    // narrows `stage` to non-null keeps that guarantee. TypeScript cannot see this because
    // the core's own `stage` is the wider nullable type.
    state: {
      ...state,
      ...outcome.changes,
      lastAppliedSequence: toEventSequence(message.sequence),
      appliedEventFingerprints: fingerprints,
      fingerprintFloor: floor,
    } as unknown as S,
  };
}
