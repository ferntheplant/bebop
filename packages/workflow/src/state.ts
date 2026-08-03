import type {
  AttentionKind,
  Candidate,
  CandidateGate,
  Controller,
  EffectiveSpec,
  EventSequence,
  GateStatus,
  GitSha,
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

/**
 * The one cowboy seat currently being driven, if any.
 *
 * At most one is active ("One controller drives one active cowboy" (ADR 0037)), and a deterministic stage —
 * local validation, the CI poll, evidence upload — legitimately runs with none. Who is driving it is
 * `controller`, not a property of the seat: a taken-over seat is the same seat with a different driver.
 */
export interface ActiveCowboy {
  readonly role: SeatRole;
  readonly seatId: SeatId;
}

/**
 * Why the workflow stopped, and what the stage was when it did.
 *
 * The permitted exits are not stored: they are a function of `kind` alone, so `resolutionsForAttention` derives
 * them on read and a record can never offer an exit its kind forbids.
 */
export interface AttentionState {
  readonly kind: AttentionKind;
  readonly reason: string;
  readonly raisedAt: Timestamp;
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
 *
 * Stage, `controller`, and `attention` are three independent dimensions
 * ("One controller drives one active cowboy" (ADR 0037)). Stage says what work is happening, `controller` says
 * who is directing it, and `attention` says why it stopped. Reading any one of them never requires the others,
 * which is what a single `stage` field encoding all three could not offer: taking over review used to look like
 * leaving review.
 */
export interface WorkflowCoreState {
  readonly lastAppliedSequence: EventSequence;
  readonly appliedEventFingerprints: Readonly<Record<number, string>>;
  readonly fingerprintFloor: number;
  readonly stage: SwordfishStage | null;
  /** The work stage to resume into once `needs_attention` clears; null whenever the stage is not suspended. */
  readonly suspendedStage: SwordfishStage | null;
  readonly controller: Controller;
  readonly activeCowboy: ActiveCowboy | null;
  readonly effectiveSpec: EffectiveSpec | null;
  readonly candidate: Candidate | null;
  readonly gates: GateStates;
  readonly readinessClaim: ReadinessClaim | null;
  readonly previews: ReadonlyArray<PrivatePreviewAttachment>;
  readonly attention: AttentionState | null;
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
    controller: "swordfish",
    activeCowboy: null,
    effectiveSpec: null,
    candidate: null,
    gates: initialGates(),
    readinessClaim: null,
    previews: [],
    attention: null,
  };
}
