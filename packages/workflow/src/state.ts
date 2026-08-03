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
  WorkflowResolution,
} from "@bebop/contracts";
import { resolutionsForAttention } from "@bebop/contracts";

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
 * One reason the workflow stopped.
 *
 * The permitted exits are not stored: they are a function of `kind` alone, so `resolutionsForAttention` derives
 * them on read and a record can never offer an exit its kind forbids.
 */
export interface AttentionState {
  readonly kind: AttentionKind;
  readonly reason: string;
  readonly raisedAt: Timestamp;
}

/**
 * Every outstanding reason, not just the newest.
 *
 * A single record let a later, laxer reason overwrite a stricter one: an `operational` attention raised during
 * startup reconciliation would replace an outstanding `constraint_exhausted`, and because `operational` permits
 * `resume`, the exhausted attempt could then be revived without the explicit grant
 * ("Workflow actions have role-aware adapters" (ADR 0038)) requires. Reasons therefore accumulate, each is
 * cleared by its own permitted resolution, and the workflow resumes only once none remain.
 *
 * At most one record per kind: a second reason of the same kind is a restatement, so it replaces rather than
 * accumulating without bound.
 */
export type AttentionStates = ReadonlyArray<AttentionState>;

/** The resolutions that clear at least one outstanding reason. */
export function offeredResolutions(attention: AttentionStates): ReadonlyArray<WorkflowResolution> {
  const offered: Array<WorkflowResolution> = [];
  for (const record of attention) {
    for (const resolution of resolutionsForAttention[record.kind]) {
      if (!offered.includes(resolution)) offered.push(resolution);
    }
  }
  return offered;
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
  readonly attention: AttentionStates;
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
    attention: [],
  };
}
