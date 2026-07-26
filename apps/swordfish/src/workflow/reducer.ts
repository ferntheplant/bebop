import { EventMessage } from "@bebop/contracts";
import type {
  Candidate,
  CandidateGate,
  EffectiveSpec,
  EventSequence,
  GateStatus,
  GitSha,
  LeaseOwner,
  PrivatePreviewAttachment,
  SeatId,
  SeatRole,
  SpecRevision,
  SwordfishStage,
  Timestamp,
} from "@bebop/contracts";
import { Schema } from "effect";

export interface GateState {
  readonly status: GateStatus;
  readonly completedAt?: Timestamp;
}

export type GateStates = Readonly<Record<CandidateGate, GateState>>;

export interface SeatLeaseState {
  readonly seatId: SeatId;
  readonly owner: LeaseOwner;
}

export interface ReadinessClaim {
  readonly candidateSha: GitSha;
  readonly specRevision: SpecRevision;
}

export interface SwordfishWorkflowState {
  readonly lastAppliedSequence: EventSequence;
  readonly appliedEventFingerprints: Readonly<Record<number, string>>;
  readonly stage: SwordfishStage;
  readonly suspendedStage: SwordfishStage | null;
  readonly effectiveSpec: EffectiveSpec | null;
  readonly candidate: Candidate | null;
  readonly gates: GateStates;
  readonly readinessClaim: ReadinessClaim | null;
  readonly leases: Readonly<Partial<Record<SeatRole, SeatLeaseState>>>;
  readonly previews: ReadonlyArray<PrivatePreviewAttachment>;
  readonly attentionReason: string | null;
}

export type WorkflowReducerError =
  | { readonly type: "sequence_gap"; readonly expected: number; readonly received: number }
  | { readonly type: "sequence_collision"; readonly sequence: number }
  | { readonly type: "illegal_transition"; readonly stage: SwordfishStage; readonly eventType: string }
  | { readonly type: "spec_revision_mismatch"; readonly expected: number; readonly received: number }
  | { readonly type: "candidate_mismatch"; readonly expectedSha: GitSha | null; readonly receivedSha: GitSha }
  | { readonly type: "gate_not_pending"; readonly gate: CandidateGate; readonly status: GateStatus };

export type WorkflowReducerResult =
  | { readonly ok: true; readonly applied: boolean; readonly state: SwordfishWorkflowState }
  | { readonly ok: false; readonly error: WorkflowReducerError };

function initialGates(): GateStates {
  return {
    local_validation: { status: "not_started" },
    pr_ci: { status: "not_started" },
    code_review: { status: "not_started" },
    qa: { status: "not_started" },
    evidence_upload: { status: "not_started" },
  };
}

export function makeInitialSwordfishWorkflowState(): SwordfishWorkflowState {
  return {
    lastAppliedSequence: 0 as EventSequence,
    appliedEventFingerprints: {},
    stage: "interactive",
    suspendedStage: null,
    effectiveSpec: null,
    candidate: null,
    gates: initialGates(),
    readinessClaim: null,
    leases: {},
    previews: [],
    attentionReason: null,
  };
}

function illegal(state: SwordfishWorkflowState, eventType: string): WorkflowReducerResult {
  return { ok: false, error: { type: "illegal_transition", stage: state.stage, eventType } };
}

function applied(
  state: SwordfishWorkflowState,
  message: EventMessage,
  changes: Partial<SwordfishWorkflowState>,
): WorkflowReducerResult {
  return {
    ok: true,
    applied: true,
    state: {
      ...state,
      ...changes,
      lastAppliedSequence: message.sequence as number as EventSequence,
      appliedEventFingerprints: {
        ...state.appliedEventFingerprints,
        [message.sequence]: eventFingerprint(message),
      },
    },
  };
}

function eventFingerprint(message: EventMessage): string {
  return JSON.stringify(Schema.encodeSync(EventMessage)(message));
}

function stageChanges(
  state: SwordfishWorkflowState,
  nextStage: SwordfishStage,
): Pick<Partial<SwordfishWorkflowState>, "stage" | "suspendedStage"> {
  return state.stage === "human_controlled" || state.stage === "needs_attention" || state.stage === "blocked"
    ? { suspendedStage: nextStage }
    : { stage: nextStage };
}

function attentionChanges(
  state: SwordfishWorkflowState,
): Pick<Partial<SwordfishWorkflowState>, "stage" | "suspendedStage"> {
  if (state.stage === "human_controlled") {
    return {};
  }
  if (state.stage === "needs_attention") {
    return {};
  }
  return { stage: "needs_attention", suspendedStage: state.suspendedStage ?? state.stage };
}

function gateStage(gates: GateStates): SwordfishStage {
  if (gates.pr_ci.status === "failed" || gates.code_review.status === "failed") {
    return "revision";
  }
  if (gates.pr_ci.status === "passed" && gates.code_review.status === "passed") {
    return "qa_preparing";
  }
  if (gates.pr_ci.status === "passed") {
    return "code_review";
  }
  if (gates.code_review.status === "passed") {
    return "pr_ci";
  }
  return "pushed_candidate";
}

function completeGate(state: SwordfishWorkflowState, message: EventMessage): WorkflowReducerResult {
  const event = message.event;
  if (event.type !== "gate_completed") {
    return illegal(state, event.type);
  }
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
  const currentGate = state.gates[event.gate];
  if (currentGate.status !== "pending") {
    return { ok: false, error: { type: "gate_not_pending", gate: event.gate, status: currentGate.status } };
  }
  const gates: GateStates = {
    ...state.gates,
    [event.gate]: { status: event.outcome, completedAt: message.occurredAt },
  };
  if (event.outcome === "failed") {
    return applied(state, message, { gates, ...stageChanges(state, "revision"), readinessClaim: null });
  }
  if (event.gate === "local_validation") {
    return applied(state, message, { gates });
  }
  if (event.gate === "pr_ci" || event.gate === "code_review") {
    return applied(state, message, { gates, ...stageChanges(state, gateStage(gates)) });
  }
  if (event.gate === "qa") {
    return applied(state, message, {
      gates: { ...gates, evidence_upload: { status: "pending" } },
      ...stageChanges(state, "evidence_upload"),
    });
  }
  return applied(state, message, {
    gates,
    ...stageChanges(state, "ready"),
    readinessClaim: { candidateSha: event.candidateSha, specRevision: event.specRevision },
  });
}

function changeStage(state: SwordfishWorkflowState, message: EventMessage): WorkflowReducerResult {
  const event = message.event;
  if (event.type !== "stage_changed") {
    return illegal(state, event.type);
  }
  if (
    (state.stage === "human_controlled" || state.stage === "needs_attention" || state.stage === "blocked") &&
    state.suspendedStage === event.stage
  ) {
    return applied(state, message, { stage: event.stage, suspendedStage: null, attentionReason: null });
  }
  if (event.stage === "pushed_candidate") {
    return state.stage === "local_validation" && state.gates.local_validation.status === "passed"
      ? applied(state, message, {
          stage: "pushed_candidate",
          gates: { ...state.gates, pr_ci: { status: "pending" }, code_review: { status: "pending" } },
        })
      : illegal(state, event.type);
  }
  if (event.stage === "qa_running") {
    return state.stage === "qa_preparing"
      ? applied(state, message, { stage: "qa_running", gates: { ...state.gates, qa: { status: "pending" } } })
      : illegal(state, event.type);
  }
  if (event.stage === "human_controlled" || event.stage === "needs_attention" || event.stage === "blocked") {
    if (state.stage === "cancelled" || state.stage === "failed") {
      return illegal(state, event.type);
    }
    return state.stage === "human_controlled" && event.stage !== "human_controlled"
      ? applied(state, message, {
          stage: event.stage,
          attentionReason:
            event.stage === "needs_attention" ? (event.reason ?? state.attentionReason) : state.attentionReason,
        })
      : applied(state, message, {
          stage: event.stage,
          suspendedStage: state.suspendedStage ?? state.stage,
          attentionReason:
            event.stage === "needs_attention" ? (event.reason ?? state.attentionReason) : state.attentionReason,
        });
  }
  if (event.stage === "cancelling" && state.stage !== "cancelled" && state.stage !== "failed") {
    return applied(state, message, { stage: "cancelling" });
  }
  if (event.stage === "cancelled" && state.stage === "cancelling") {
    return applied(state, message, { stage: "cancelled", suspendedStage: null });
  }
  if (event.stage === "failed" && state.stage !== "cancelled") {
    return applied(state, message, { stage: "failed", suspendedStage: null });
  }
  return illegal(state, event.type);
}

export function reduceSwordfishWorkflow(state: SwordfishWorkflowState, message: EventMessage): WorkflowReducerResult {
  if (
    state.appliedEventFingerprints[message.sequence] !== undefined &&
    state.appliedEventFingerprints[message.sequence] !== eventFingerprint(message)
  ) {
    return { ok: false, error: { type: "sequence_collision", sequence: message.sequence } };
  }
  if (message.sequence <= state.lastAppliedSequence) {
    return { ok: true, applied: false, state };
  }
  const expected = state.lastAppliedSequence + 1;
  if (message.sequence !== expected) {
    return { ok: false, error: { type: "sequence_gap", expected, received: message.sequence } };
  }
  if (state.stage === "cancelled" || state.stage === "failed") {
    return illegal(state, message.event.type);
  }

  const event = message.event;
  switch (event.type) {
    case "effective_spec_set": {
      if (state.stage !== "interactive" && state.stage !== "human_controlled") {
        return illegal(state, event.type);
      }
      const expectedRevision = state.effectiveSpec === null ? 1 : state.effectiveSpec.revision + 1;
      if (event.spec.revision !== expectedRevision) {
        return {
          ok: false,
          error: { type: "spec_revision_mismatch", expected: expectedRevision, received: event.spec.revision },
        };
      }
      return applied(state, message, {
        stage: "implementing",
        suspendedStage: null,
        effectiveSpec: event.spec,
        candidate: null,
        gates: initialGates(),
        readinessClaim: null,
        attentionReason: null,
      });
    }
    case "candidate_submitted": {
      if (state.stage !== "implementing" && state.stage !== "revision") {
        return illegal(state, event.type);
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
      return applied(state, message, {
        stage: "local_validation",
        candidate: event.candidate,
        gates: { ...initialGates(), local_validation: { status: "pending" } },
        readinessClaim: null,
      });
    }
    case "gate_completed":
      return completeGate(state, message);
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
      return applied(state, message, {
        ...stageChanges(state, "revision"),
        candidate: null,
        gates: initialGates(),
        readinessClaim: null,
      });
    }
    case "stage_changed":
      return changeStage(state, message);
    case "lease_changed":
      return applied(state, message, {
        leases: { ...state.leases, [event.seat]: { seatId: event.seatId, owner: event.owner } },
      });
    case "attachments_updated":
      return applied(state, message, { previews: event.previews });
    case "attention_required":
      return applied(state, message, {
        ...attentionChanges(state),
        attentionReason: event.reason,
      });
  }
}
