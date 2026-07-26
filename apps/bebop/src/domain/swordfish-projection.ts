import { EventMessage } from "@bebop/contracts";
import type {
  BountyId,
  Candidate,
  CandidateGate,
  EffectiveSpec,
  EventSequence,
  GateStatus,
  GitSha,
  HeartbeatMessage,
  ConnectionId,
  LeaseOwner,
  PrivatePreviewAttachment,
  SeatId,
  SeatRole,
  SpecRevision,
  SwordfishStage,
  SwordfishFreshnessStatus,
  Timestamp,
  VmId,
} from "@bebop/contracts";
import { Schema } from "effect";

interface GateState {
  readonly status: GateStatus;
  readonly completedAt?: Timestamp;
}

type GateStates = Readonly<Record<CandidateGate, GateState>>;

interface SeatLeaseState {
  readonly seatId: SeatId;
  readonly owner: LeaseOwner;
}

export type SwordfishFreshness =
  | { readonly status: Extract<SwordfishFreshnessStatus, "never_connected"> }
  | {
      readonly status: Extract<SwordfishFreshnessStatus, "connected">;
      readonly lastObservedAt: Timestamp;
      readonly lastHeartbeatSentAt?: Timestamp;
    }
  | {
      readonly status: Extract<SwordfishFreshnessStatus, "disconnected" | "stale">;
      readonly lastObservedAt: Timestamp;
    };

export interface BebopSwordfishProjection {
  readonly bountyId: BountyId;
  readonly vmId: VmId;
  readonly lastAppliedSequence: EventSequence;
  readonly appliedEventFingerprints: Readonly<Record<number, string>>;
  readonly lastProducedSequence: EventSequence;
  readonly connectionId: ConnectionId | null;
  readonly stage: SwordfishStage | null;
  readonly suspendedStage: SwordfishStage | null;
  readonly effectiveSpec: EffectiveSpec | null;
  readonly candidate: Candidate | null;
  readonly gates: GateStates;
  readonly readinessClaim: { readonly candidateSha: GitSha; readonly specRevision: SpecRevision } | null;
  readonly leases: Readonly<Partial<Record<SeatRole, SeatLeaseState>>>;
  readonly previews: ReadonlyArray<PrivatePreviewAttachment>;
  readonly attentionReason: string | null;
  readonly freshness: SwordfishFreshness;
}

export type BebopProjectionInput =
  | {
      readonly type: "connection_registered";
      readonly connectionId: ConnectionId;
      readonly observedAt: Timestamp;
    }
  | { readonly type: "event_received"; readonly connectionId: ConnectionId; readonly message: EventMessage }
  | {
      readonly type: "heartbeat_observed";
      readonly connectionId: ConnectionId;
      readonly message: HeartbeatMessage;
      readonly observedAt: Timestamp;
    }
  | { readonly type: "connection_lost"; readonly connectionId: ConnectionId; readonly detectedAt: Timestamp }
  | { readonly type: "freshness_expired"; readonly connectionId: ConnectionId; readonly detectedAt: Timestamp };

export type BebopProjectionError =
  | { readonly type: "identity_mismatch"; readonly expectedBountyId: BountyId; readonly expectedVmId: VmId }
  | { readonly type: "sequence_gap"; readonly expected: number; readonly received: number }
  | { readonly type: "sequence_collision"; readonly sequence: number }
  | { readonly type: "illegal_transition"; readonly stage: SwordfishStage | null; readonly eventType: string }
  | { readonly type: "candidate_mismatch"; readonly expectedSha: GitSha | null; readonly receivedSha: GitSha }
  | { readonly type: "spec_revision_mismatch"; readonly expected: number; readonly received: number }
  | { readonly type: "gate_not_pending"; readonly gate: CandidateGate; readonly status: GateStatus };

export type BebopProjectionResult =
  | { readonly ok: true; readonly applied: boolean; readonly state: BebopSwordfishProjection }
  | { readonly ok: false; readonly error: BebopProjectionError };

function initialGates(): GateStates {
  return {
    local_validation: { status: "not_started" },
    pr_ci: { status: "not_started" },
    code_review: { status: "not_started" },
    qa: { status: "not_started" },
    evidence_upload: { status: "not_started" },
  };
}

export function makeInitialBebopSwordfishProjection(bountyId: BountyId, vmId: VmId): BebopSwordfishProjection {
  return {
    bountyId,
    vmId,
    lastAppliedSequence: 0 as EventSequence,
    appliedEventFingerprints: {},
    lastProducedSequence: 0 as EventSequence,
    connectionId: null,
    stage: null,
    suspendedStage: null,
    effectiveSpec: null,
    candidate: null,
    gates: initialGates(),
    readinessClaim: null,
    leases: {},
    previews: [],
    attentionReason: null,
    freshness: { status: "never_connected" },
  };
}

function identityError(state: BebopSwordfishProjection): BebopProjectionResult {
  return {
    ok: false,
    error: { type: "identity_mismatch", expectedBountyId: state.bountyId, expectedVmId: state.vmId },
  };
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

function eventFingerprint(message: EventMessage): string {
  return JSON.stringify(Schema.encodeSync(EventMessage)(message));
}

function stageChanges(
  state: BebopSwordfishProjection,
  nextStage: SwordfishStage,
): Pick<Partial<BebopSwordfishProjection>, "stage" | "suspendedStage"> {
  return state.stage === "human_controlled" || state.stage === "needs_attention" || state.stage === "blocked"
    ? { suspendedStage: nextStage }
    : { stage: nextStage };
}

function attentionChanges(
  state: BebopSwordfishProjection,
): Pick<Partial<BebopSwordfishProjection>, "stage" | "suspendedStage"> {
  if (state.stage === "human_controlled") {
    return {};
  }
  if (state.stage === "needs_attention") {
    return {};
  }
  return { stage: "needs_attention", suspendedStage: state.suspendedStage ?? state.stage };
}

function projectEvent(state: BebopSwordfishProjection, message: EventMessage): BebopProjectionResult {
  const event = message.event;
  let changes: Partial<BebopSwordfishProjection>;
  switch (event.type) {
    case "stage_changed":
      if (
        (state.stage === "human_controlled" || state.stage === "needs_attention" || state.stage === "blocked") &&
        state.suspendedStage === event.stage
      ) {
        changes = { stage: event.stage, suspendedStage: null };
      } else if (event.stage === "pushed_candidate") {
        if (state.stage !== "local_validation" || state.gates.local_validation.status !== "passed") {
          return { ok: false, error: { type: "illegal_transition", stage: state.stage, eventType: event.type } };
        }
        changes = {
          stage: event.stage,
          gates: { ...state.gates, pr_ci: { status: "pending" }, code_review: { status: "pending" } },
        };
      } else if (event.stage === "qa_running") {
        if (state.stage !== "qa_preparing") {
          return { ok: false, error: { type: "illegal_transition", stage: state.stage, eventType: event.type } };
        }
        changes = { stage: event.stage, gates: { ...state.gates, qa: { status: "pending" } } };
      } else if (event.stage === "human_controlled" || event.stage === "needs_attention" || event.stage === "blocked") {
        if (state.stage === "cancelled" || state.stage === "failed") {
          return { ok: false, error: { type: "illegal_transition", stage: state.stage, eventType: event.type } };
        }
        changes =
          state.stage === "human_controlled" && event.stage !== "human_controlled"
            ? { stage: event.stage }
            : { stage: event.stage, suspendedStage: state.suspendedStage ?? state.stage };
      } else if (event.stage === "cancelling" && state.stage !== "cancelled" && state.stage !== "failed") {
        changes = { stage: "cancelling" };
      } else if (event.stage === "cancelled" && state.stage === "cancelling") {
        changes = { stage: "cancelled", suspendedStage: null };
      } else if (event.stage === "failed" && state.stage !== "cancelled") {
        changes = { stage: "failed", suspendedStage: null };
      } else {
        return { ok: false, error: { type: "illegal_transition", stage: state.stage, eventType: event.type } };
      }
      break;
    case "lease_changed":
      changes = { leases: { ...state.leases, [event.seat]: { seatId: event.seatId, owner: event.owner } } };
      break;
    case "effective_spec_set":
      if (state.stage !== null && state.stage !== "interactive" && state.stage !== "human_controlled") {
        return { ok: false, error: { type: "illegal_transition", stage: state.stage, eventType: event.type } };
      }
      if (event.spec.revision !== (state.effectiveSpec?.revision ?? 0) + 1) {
        return {
          ok: false,
          error: {
            type: "spec_revision_mismatch",
            expected: (state.effectiveSpec?.revision ?? 0) + 1,
            received: event.spec.revision,
          },
        };
      }
      changes = {
        stage: "implementing",
        suspendedStage: null,
        effectiveSpec: event.spec,
        candidate: null,
        gates: initialGates(),
        readinessClaim: null,
        attentionReason: null,
      };
      break;
    case "candidate_submitted": {
      if (state.stage !== "implementing" && state.stage !== "revision") {
        return { ok: false, error: { type: "illegal_transition", stage: state.stage, eventType: event.type } };
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
      changes = {
        stage: "local_validation",
        candidate: event.candidate,
        gates: { ...initialGates(), local_validation: { status: "pending" } },
        readinessClaim: null,
      };
      break;
    }
    case "attention_required":
      changes = { ...attentionChanges(state), attentionReason: event.reason };
      break;
    case "attachments_updated":
      changes = { previews: event.previews };
      break;
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
      changes = { ...stageChanges(state, "revision"), candidate: null, gates: initialGates(), readinessClaim: null };
      break;
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
      const gate = state.gates[event.gate];
      if (gate.status !== "pending") {
        return { ok: false, error: { type: "gate_not_pending", gate: event.gate, status: gate.status } };
      }
      let gates: GateStates = {
        ...state.gates,
        [event.gate]: { status: event.outcome, completedAt: message.occurredAt },
      };
      let nextStage: SwordfishStage | null = null;
      let readinessClaim = state.readinessClaim;
      if (event.outcome === "failed") {
        nextStage = "revision";
        readinessClaim = null;
      } else if (event.gate === "pr_ci" || event.gate === "code_review") {
        nextStage = gateStage(gates);
      } else if (event.gate === "qa") {
        gates = { ...gates, evidence_upload: { status: "pending" } };
        nextStage = "evidence_upload";
      } else if (event.gate === "evidence_upload") {
        nextStage = "ready";
        readinessClaim = { candidateSha: event.candidateSha, specRevision: event.specRevision };
      }
      changes = {
        gates,
        ...(nextStage === null ? {} : stageChanges(state, nextStage)),
        readinessClaim,
      };
      break;
    }
  }
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
      lastProducedSequence: Math.max(state.lastProducedSequence, message.sequence) as EventSequence,
    },
  };
}

export function reduceBebopSwordfishProjection(
  state: BebopSwordfishProjection,
  input: BebopProjectionInput,
): BebopProjectionResult {
  if (input.type === "connection_registered") {
    return {
      ok: true,
      applied: true,
      state: {
        ...state,
        connectionId: input.connectionId,
        freshness: { status: "connected", lastObservedAt: input.observedAt },
      },
    };
  }
  if (input.type === "connection_lost" || input.type === "freshness_expired") {
    if (state.connectionId !== input.connectionId) {
      return { ok: true, applied: false, state };
    }
    if (input.type === "freshness_expired" && state.freshness.status !== "connected") {
      return { ok: true, applied: false, state };
    }
    const lastObservedAt =
      state.freshness.status === "never_connected" ? input.detectedAt : state.freshness.lastObservedAt;
    return {
      ok: true,
      applied: true,
      state: {
        ...state,
        connectionId: input.type === "connection_lost" ? null : state.connectionId,
        freshness: {
          status: input.type === "connection_lost" ? "disconnected" : "stale",
          lastObservedAt,
        },
      },
    };
  }
  if (input.type === "heartbeat_observed") {
    if (state.connectionId !== input.connectionId || state.freshness.status !== "connected") {
      return { ok: true, applied: false, state };
    }
    const message = input.message;
    if (message.bountyId !== state.bountyId || message.vmId !== state.vmId) {
      return identityError(state);
    }
    return {
      ok: true,
      applied: true,
      state: {
        ...state,
        lastProducedSequence: Math.max(state.lastProducedSequence, message.lastProducedEventSequence) as EventSequence,
        freshness: {
          status: "connected",
          lastObservedAt: input.observedAt,
          lastHeartbeatSentAt: message.sentAt,
        },
      },
    };
  }
  const message = input.message;
  if (state.connectionId !== input.connectionId || state.freshness.status !== "connected") {
    return { ok: true, applied: false, state };
  }
  if (message.bountyId !== state.bountyId || message.vmId !== state.vmId) {
    return identityError(state);
  }
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
  return projectEvent(state, message);
}
