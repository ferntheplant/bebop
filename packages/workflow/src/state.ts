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

/**
 * The fields whose interpretation is identical in Swordfish and in Bebop's projection.
 *
 * `stage` is nullable here because Bebop's projection starts before it has heard anything
 * from a Swordfish, while Swordfish itself starts at `interactive` (`docs/capabilities/06-autonomous-implementation.md`).
 * Each app narrows the field in its own state type; the core never writes null to it.
 */
export interface WorkflowCoreState {
  readonly lastAppliedSequence: EventSequence;
  readonly appliedEventFingerprints: Readonly<Record<number, string>>;
  readonly fingerprintFloor: number;
  readonly stage: SwordfishStage | null;
  readonly suspendedStage: SwordfishStage | null;
  readonly effectiveSpec: EffectiveSpec | null;
  readonly candidate: Candidate | null;
  readonly gates: GateStates;
  readonly readinessClaim: ReadinessClaim | null;
  readonly leases: Readonly<Partial<Record<SeatRole, SeatLeaseState>>>;
  readonly previews: ReadonlyArray<PrivatePreviewAttachment>;
  readonly attentionReason: string | null;
}

/**
 * How many applied sequences keep a retained fingerprint.
 *
 * Fingerprints exist to catch conflicting replay near the acknowledgement frontier, which
 * is a bounded window: a peer cannot replay a sequence it was acknowledged for long ago and
 * has therefore dropped from its outbox. Retaining every fingerprint for the life of a
 * bounty stores each event twice in durable state for no additional safety.
 */
export const fingerprintWindow = 128;

export function initialGates(): GateStates {
  return {
    local_validation: { status: "not_started" },
    pr_ci: { status: "not_started" },
    code_review: { status: "not_started" },
    qa: { status: "not_started" },
    evidence_upload: { status: "not_started" },
  };
}

/** The core fields of a state that has applied nothing yet. */
export function initialWorkflowCoreState(): Omit<WorkflowCoreState, "stage"> {
  return {
    lastAppliedSequence: 0 as EventSequence,
    appliedEventFingerprints: {},
    fingerprintFloor: 1,
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
