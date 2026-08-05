import type {
  AttentionKind,
  Candidate,
  CandidateGate,
  ConstraintProfile,
  ConstraintScope,
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
import { constraintScopes, defaultConstraintProfile, resolutionsForAttention } from "@bebop/contracts";

export interface GateState {
  readonly status: GateStatus;
  readonly completedAt?: Timestamp;
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
export function isSuspended(stage: SwordfishStage | null): boolean {
  return stage === "needs_attention" || stage === "cancelling";
}

export function isTerminal(stage: SwordfishStage | null): boolean {
  return stage === "cancelled" || stage === "failed";
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
 * The one Swordfish-controlled cowboy assignment in flight, if any.
 *
 * Wall clock is kept as accrued milliseconds plus a running-since mark rather than as a start instant, because
 * elapsed time is not one subtraction: the clock runs only while an attempt is active, the controller is
 * Swordfish, and the work is not suspended, so a taken-over or blocked attempt accrues nothing while it waits
 * ("Constraint exhaustion is computed, not announced" (ADR 0042)). Keeping the mark in state is also what makes
 * daemon downtime count — the gap between the last pre-crash event and the first post-restart one is accrued on
 * the next event, with no timer to have missed it.
 *
 * `turnsGranted` and `wallClockGrantedMs` are additions from human `continue`, held apart from the consumed
 * counts so status can report consumed against base and granted separately rather than showing a budget that
 * silently grew ("Constraint exhaustion is computed, not announced" (ADR 0042)).
 */
export interface AttemptState {
  readonly scope: ConstraintScope;
  readonly role: SeatRole;
  readonly seatId: SeatId;
  /** 1-based within the scope's current ledger, so status can say "attempt 2 of 3". */
  readonly ordinal: number;
  readonly startedAt: Timestamp;
  readonly turns: number;
  readonly turnsGranted: number;
  readonly elapsedMs: number;
  readonly wallClockGrantedMs: number;
  /** When the clock last started running, or null while it is stopped. */
  readonly runningSince: Timestamp | null;
}

/** One scope's attempt allowance, consumed durably before a first prompt and extended only by explicit `rerun`. */
export interface ScopeLedger {
  readonly attemptsConsumed: number;
  readonly attemptsGranted: number;
}

export type ScopeLedgers = Readonly<Record<ConstraintScope, ScopeLedger>>;

export function initialScopeLedgers(): ScopeLedgers {
  return {
    building: { attemptsConsumed: 0, attemptsGranted: 0 },
    review: { attemptsConsumed: 0, attemptsGranted: 0 },
    qa: { attemptsConsumed: 0, attemptsGranted: 0 },
  };
}

/** Resets the named scopes and leaves the rest, which is what a scope boundary is. */
export function resetScopes(ledgers: ScopeLedgers, scopes: ReadonlyArray<ConstraintScope>): ScopeLedgers {
  const next = { ...ledgers };
  for (const scope of constraintScopes) {
    if (scopes.includes(scope)) next[scope] = { attemptsConsumed: 0, attemptsGranted: 0 };
  }
  return next;
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
  /**
   * The bounty's frozen constraint profile.
   *
   * It is state rather than a reducer parameter because it is frozen per bounty from the base revision and must
   * survive restart, and because Bebop's projection has to reach the same exhaustion verdict from the same
   * events — a limit passed in at each call site is a second copy for the two of them to disagree about. Where
   * it is parsed from a repository is still open ("Repository configuration in practice" on the map), and
   * nothing here depends on the answer: the ledger is built against the profile as a value.
   */
  readonly constraints: ConstraintProfile;
  readonly attempt: AttemptState | null;
  readonly ledgers: ScopeLedgers;
  /**
   * CI-passed candidates charged against the effective spec's allowance.
   *
   * There is no granted counterpart: `reopen-spec` is the only way to earn another, and it earns a whole fresh
   * allowance rather than one more slot ("CI gates cowboy review" (ADR 0040)).
   */
  readonly validatedCandidatesConsumed: number;
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

/**
 * The core fields of a state that has applied nothing yet.
 *
 * The profile is a parameter with a default so that both apps construct the same value today while the
 * repository profile is still unread, and so that threading a real frozen profile through later is one argument
 * rather than a new field on two state types.
 */
export function initialWorkflowCoreState(
  constraints: ConstraintProfile = defaultConstraintProfile,
): Omit<WorkflowCoreState, "stage"> {
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
    constraints,
    attempt: null,
    ledgers: initialScopeLedgers(),
    validatedCandidatesConsumed: 0,
  };
}
