import { Schema } from "effect";

import { PrivatePreviewAttachments } from "./attachments.ts";
import { ContinueCommand, RerunCommand, ResumeCommand, TakeoverCommand } from "./commands.ts";
import { ConstraintKind, ConstraintScope } from "./constraints.ts";
import { SwordfishEvent } from "./protocol.ts";
import {
  BountyId,
  CorrelationId,
  EventSequence,
  GitRef,
  GitSha,
  NonNegativeInteger,
  OperatorCredential,
  ProducedEventSequence,
  RepositorySlug,
  SeatId,
  SpecRevision,
  Timestamp,
  VmId,
  WorkflowRevision,
} from "./scalars.ts";
import { schemaLimits } from "./settings.ts";
import type { WorkflowResolution } from "./workflow.ts";
import {
  AttentionKind,
  CandidateGate,
  Controller,
  GateStatus,
  resolutionsForAttention,
  SeatRole,
  SwordfishStage,
} from "./workflow.ts";

export const currentSfControlVersion = 3 as const;
export const SfControlVersion = Schema.Literal(currentSfControlVersion);
export type SfControlVersion = typeof SfControlVersion.Type;

export const SfStatusCommand = Schema.Struct({ type: Schema.Literal("status") });
export const SfCancelCommand = Schema.Struct({ type: Schema.Literal("cancel") });
export const SfHandoffCommand = Schema.Struct({ type: Schema.Literal("handoff") });
export const SfControlCommand = Schema.Union([
  SfStatusCommand,
  SfCancelCommand,
  TakeoverCommand,
  SfHandoffCommand,
  ContinueCommand,
  RerunCommand,
  ResumeCommand,
]);
export type SfControlCommand = typeof SfControlCommand.Type;

export const SfControlRequest = Schema.Struct({
  type: Schema.Literal("request"),
  controlVersion: SfControlVersion,
  correlationId: CorrelationId,
  /**
   * The operator credential, presented only for mutating commands.
   *
   * `status` never carries it. `RedactedFromValue` rather than `Redacted` so the wire form is
   * a plain string: `Redacted` expects the *encoded* side to already be a `Redacted` value,
   * which nothing over the socket can produce ("Workflow actions have role-aware adapters"
   * (ADR 0038)).
   */
  operatorCredential: Schema.optionalKey(
    Schema.RedactedFromValue(OperatorCredential, { label: "operator-credential" }),
  ),
  command: SfControlCommand,
});
export type SfControlRequest = typeof SfControlRequest.Type;

/**
 * One seat Swordfish knows about.
 *
 * A seat no longer carries a lease owner. Who is driving is one workflow-wide value (`controller`), and which
 * seat is being driven is `activeCowboy`; a per-seat owner was a third representation of the same fact and could
 * disagree with both ("One controller drives one active cowboy" (ADR 0037)). Inactive seats stay listed because
 * they remain inspectable provenance.
 *
 * A role repeats across seats, and that is the normal case rather than an anomaly: every jet and faye attempt
 * gets a fresh seat, so a second review attempt legitimately produces two `jet` rows. Only the seat ID is
 * unique.
 */
export const SfSeatSnapshot = Schema.Struct({
  role: SeatRole,
  seatId: SeatId,
});
export type SfSeatSnapshot = typeof SfSeatSnapshot.Type;

/** The one seat being driven, identified by ID because the role alone no longer picks a single seat out. */
export const SfActiveCowboy = Schema.Struct({
  role: SeatRole,
  seatId: SeatId,
});
export type SfActiveCowboy = typeof SfActiveCowboy.Type;

/** Executable local commands that status may offer to clear an attention record. */
export const sfResolutionCommands = [
  "resume",
  "continue",
  "rerun building",
  "rerun validation",
  "rerun review",
  "rerun qa",
  "takeover ein",
  "takeover jet",
  "takeover faye",
  "cancel",
] as const;
type SfLocalResolutionCommand = (typeof sfResolutionCommands)[number];

/** The SHA-pinned Bebop command for the one attention kind whose authority is outside Swordfish. */
export const BebopApproveConfigResolutionCommand = Schema.TemplateLiteral([
  "bebop bounty approve-config --bounty ",
  BountyId,
  " --sha ",
  GitSha,
]);

export const SfResolutionCommand = Schema.Union([
  Schema.Literals(sfResolutionCommands),
  BebopApproveConfigResolutionCommand,
]);
export type SfResolutionCommand = typeof SfResolutionCommand.Type;

const workflowResolutionForSfCommand: Readonly<Record<SfLocalResolutionCommand, WorkflowResolution>> = {
  resume: "resume",
  continue: "continue",
  "rerun building": "rerun",
  "rerun validation": "rerun",
  "rerun review": "rerun",
  "rerun qa": "rerun",
  "takeover ein": "takeover",
  "takeover jet": "takeover",
  "takeover faye": "takeover",
  cancel: "cancel",
};

const attentionKindForTargetedSfCommand: Readonly<Partial<Record<SfLocalResolutionCommand, AttentionKind>>> = {
  "rerun building": "constraint_exhausted",
  "rerun review": "constraint_exhausted",
  "rerun qa": "constraint_exhausted",
  "rerun validation": "uncertain_gate",
};

function workflowResolutionForStatusCommand(command: SfResolutionCommand): WorkflowResolution {
  return command.startsWith("bebop bounty approve-config --bounty ")
    ? "approve_config"
    : workflowResolutionForSfCommand[command as SfLocalResolutionCommand];
}

/** One reason the bounty stopped, with the exact commands that clear it (`docs/capabilities/05-control-lease-and-takeover.md`). */
export const SfAttentionSnapshot = Schema.Struct({
  kind: AttentionKind,
  reason: Schema.String,
  resolutions: Schema.Array(SfResolutionCommand).pipe(Schema.check(Schema.isMinLength(1))),
});
export type SfAttentionSnapshot = typeof SfAttentionSnapshot.Type;

export const SfGateSnapshot = Schema.Struct({
  gate: CandidateGate,
  candidateSha: GitSha,
  specRevision: SpecRevision,
  status: GateStatus,
  attempts: NonNegativeInteger,
  updatedAt: Timestamp,
});
export type SfGateSnapshot = typeof SfGateSnapshot.Type;

/**
 * One budget, as the three numbers an operator needs to see it.
 *
 * `base` and `granted` are kept apart rather than summed because every grant is a human decision that status is
 * required to make visible: a budget shown only as its total silently absorbs the `continue` or `rerun` that
 * enlarged it ("Constraint exhaustion is computed, not announced" (ADR 0042)).
 */
export const SfBudgetSnapshot = Schema.Struct({
  consumed: NonNegativeInteger,
  base: NonNegativeInteger,
  granted: NonNegativeInteger,
});
export type SfBudgetSnapshot = typeof SfBudgetSnapshot.Type;

/** One scope's attempt ledger. */
export const SfConstraintSnapshot = Schema.Struct({
  scope: ConstraintScope,
  attempts: SfBudgetSnapshot,
});
export type SfConstraintSnapshot = typeof SfConstraintSnapshot.Type;

/**
 * The attempt in flight, with the watchdogs it is running against.
 *
 * Wall clock is milliseconds rather than the profile's minutes: the profile is what a human writes and this is
 * what a reducer accrued, and rounding accrued time to minutes for display would make status disagree with the
 * arithmetic that decides exhaustion.
 */
export const SfAttemptSnapshot = Schema.Struct({
  scope: ConstraintScope,
  role: SeatRole,
  seatId: SeatId,
  ordinal: NonNegativeInteger,
  startedAt: Timestamp,
  turns: SfBudgetSnapshot,
  wallClockMs: SfBudgetSnapshot,
  /** Whether autonomous time is accruing right now — false under human control or while suspended. */
  running: Schema.Boolean,
});
export type SfAttemptSnapshot = typeof SfAttemptSnapshot.Type;

/**
 * A budget the reducer's own arithmetic says has run out.
 *
 * Served alongside the attention record rather than folded into its free-text reason, because this is the
 * evidence for the claim: an operator can see 40/40 turns rather than a daemon's assertion that a watchdog fired
 * ("Constraint exhaustion is computed, not announced" (ADR 0042)).
 */
export const SfExhaustedConstraint = Schema.Struct({
  constraint: ConstraintKind,
  scope: Schema.optionalKey(ConstraintScope),
  consumed: NonNegativeInteger,
  allowed: NonNegativeInteger,
});
export type SfExhaustedConstraint = typeof SfExhaustedConstraint.Type;

export const SfPendingConfigApproval = Schema.Struct({
  candidateSha: GitSha,
  unifiedDiff: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.sfUnifiedDiffMaxLength)),
  ),
});
export type SfPendingConfigApproval = typeof SfPendingConfigApproval.Type;

/**
 * The live Bebop connection, reported beside the stage.
 *
 * Three states, because an operator cannot tell "retrying with backoff" from "stuck" by the
 * stage alone (`docs/capabilities/03-the-cockpit.md`). `never_connected` is a daemon that has
 * not reached Bebop yet since it started; `disconnected` is one that reached it and lost it.
 * Both non-connected states carry the timestamp the duration is derived from on read, and the
 * moment the next attempt is due — the reconnect loop is the only writer, so the state is the
 * live connection, never a column ("The state is derived from the live connection rather than
 * stored").
 */
export const SfBebopConnectionConnected = Schema.Struct({
  state: Schema.Literal("connected"),
  connectedAt: Timestamp,
  lastContactAt: Schema.optionalKey(Timestamp),
  acknowledgedThrough: EventSequence,
  pendingEventCount: NonNegativeInteger,
});
export type SfBebopConnectionConnected = typeof SfBebopConnectionConnected.Type;

export const SfBebopConnectionDisconnected = Schema.Struct({
  state: Schema.Literal("disconnected"),
  disconnectedSince: Timestamp,
  nextAttemptAt: Timestamp,
  lastContactAt: Schema.optionalKey(Timestamp),
  acknowledgedThrough: EventSequence,
  pendingEventCount: NonNegativeInteger,
});
export type SfBebopConnectionDisconnected = typeof SfBebopConnectionDisconnected.Type;

export const SfBebopConnectionNeverConnected = Schema.Struct({
  state: Schema.Literal("never_connected"),
  neverConnectedSince: Timestamp,
  acknowledgedThrough: EventSequence,
  pendingEventCount: NonNegativeInteger,
});
export type SfBebopConnectionNeverConnected = typeof SfBebopConnectionNeverConnected.Type;

export const SfBebopConnectionSnapshot = Schema.Union([
  SfBebopConnectionConnected,
  SfBebopConnectionDisconnected,
  SfBebopConnectionNeverConnected,
]);
export type SfBebopConnectionSnapshot = typeof SfBebopConnectionSnapshot.Type;

export const SfRecentEvent = Schema.Struct({
  sequence: ProducedEventSequence,
  occurredAt: Timestamp,
  event: SwordfishEvent,
});
export type SfRecentEvent = typeof SfRecentEvent.Type;

const SfStatusSnapshotBase = Schema.Struct({
  stateRevision: WorkflowRevision,
  observedAt: Timestamp,
  bountyId: BountyId,
  vmId: VmId,
  repository: RepositorySlug,
  assignedBranch: GitRef,
  stage: SwordfishStage,
  controller: Controller,
  suspendedStage: Schema.optionalKey(SwordfishStage),
  attention: Schema.Array(SfAttentionSnapshot),
  effectiveSpecRevision: Schema.optionalKey(SpecRevision),
  activeCowboy: Schema.optionalKey(SfActiveCowboy),
  seats: Schema.Array(SfSeatSnapshot),
  candidateSha: Schema.optionalKey(GitSha),
  gates: Schema.Array(SfGateSnapshot),
  attempt: Schema.optionalKey(SfAttemptSnapshot),
  constraints: Schema.Array(SfConstraintSnapshot),
  validatedCandidates: SfBudgetSnapshot,
  exhausted: Schema.Array(SfExhaustedConstraint),
  pendingConfigApproval: Schema.optionalKey(SfPendingConfigApproval),
  bebopConnection: SfBebopConnectionSnapshot,
  previews: PrivatePreviewAttachments,
  recentEvents: Schema.Array(SfRecentEvent).pipe(Schema.check(Schema.isMaxLength(schemaLimits.sfRecentEventsMaxItems))),
});
export const SfStatusSnapshot = SfStatusSnapshotBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof SfStatusSnapshotBase.Type>((snapshot) => {
      // Seat IDs are unique; roles deliberately are not. A second jet or faye attempt requires a fresh seat, so
      // repeated roles are what a normal retry looks like in this list (ADR 0037).
      const seatIds = new Set(snapshot.seats.map((seat) => seat.seatId));
      if (seatIds.size !== snapshot.seats.length) {
        return "Expected unique Swordfish seat IDs";
      }
      const activeCowboy = snapshot.activeCowboy;
      if (
        activeCowboy !== undefined &&
        !snapshot.seats.some((seat) => seat.seatId === activeCowboy.seatId && seat.role === activeCowboy.role)
      ) {
        return "Expected the active cowboy to exist in the seat snapshot";
      }
      // A stopped bounty always states why, so the cockpit can print the commands that restart it. The converse
      // is weaker than it looks: a reason raised after a stop command is retained through `cancelling` without
      // reviving the run, so attention outlives `needs_attention` on the cancellation path.
      if (snapshot.stage === "needs_attention" && snapshot.attention.length === 0) {
        return "Expected the needs_attention stage to state at least one reason";
      }
      if (snapshot.attention.length > 0 && snapshot.stage !== "needs_attention" && snapshot.stage !== "cancelling") {
        return "Expected outstanding attention only while suspended or cancelling";
      }
      const kinds = new Set(snapshot.attention.map((record) => record.kind));
      if (kinds.size !== snapshot.attention.length) {
        return "Expected at most one outstanding reason per attention kind";
      }
      for (const record of snapshot.attention) {
        const permitted: ReadonlyArray<WorkflowResolution> = resolutionsForAttention[record.kind];
        const expectedApprovalCommand =
          snapshot.candidateSha === undefined
            ? null
            : `bebop bounty approve-config --bounty ${snapshot.bountyId} --sha ${snapshot.candidateSha}`;
        if (
          record.resolutions.some((command) => {
            const targetKind = attentionKindForTargetedSfCommand[command as SfLocalResolutionCommand];
            return (
              !permitted.includes(workflowResolutionForStatusCommand(command)) ||
              (targetKind !== undefined && targetKind !== record.kind) ||
              (command.startsWith("bebop bounty approve-config --bounty ") && command !== expectedApprovalCommand)
            );
          })
        ) {
          return "Expected every offered resolution to be permitted by the attention kind";
        }
      }
      const gates = new Set(snapshot.gates.map((gate) => gate.gate));
      if (gates.size !== snapshot.gates.length) {
        return "Expected unique candidate gates";
      }
      const constraints = new Set(snapshot.constraints.map((constraint) => constraint.scope));
      if (constraints.size !== snapshot.constraints.length) {
        return "Expected one constraint ledger entry per scope";
      }
      // An attempt is one cowboy assignment, so it names the seat being driven rather than a seat of its own.
      const attempt = snapshot.attempt;
      if (attempt !== undefined && (activeCowboy === undefined || activeCowboy.seatId !== attempt.seatId)) {
        return "Expected the attempt in flight to belong to the active cowboy";
      }
      if (attempt !== undefined && attempt.running && snapshot.controller !== "swordfish") {
        return "Expected an attempt clock to be stopped while a human holds control";
      }
      if (snapshot.candidateSha === undefined) {
        if (snapshot.stage === "ready") {
          return "Expected ready status to identify a candidate";
        }
        return snapshot.gates.length > 0 || snapshot.pendingConfigApproval !== undefined
          ? "Expected candidate-bound status only when a candidate exists"
          : undefined;
      }
      if (snapshot.effectiveSpecRevision === undefined) {
        return "Expected a candidate to reference an effective spec revision";
      }
      if (snapshot.gates.some((gate) => gate.candidateSha !== snapshot.candidateSha)) {
        return "Expected every gate to match the current candidate";
      }
      if (snapshot.gates.some((gate) => gate.specRevision !== snapshot.effectiveSpecRevision)) {
        return "Expected every gate to match the effective spec revision";
      }
      if (
        snapshot.stage === "ready" &&
        (snapshot.gates.length !== 5 || snapshot.gates.some((gate) => gate.status !== "passed"))
      ) {
        return "Expected every candidate gate to pass before ready";
      }
      return snapshot.pendingConfigApproval === undefined ||
        snapshot.pendingConfigApproval.candidateSha === snapshot.candidateSha
        ? undefined
        : "Expected pending configuration approval to match the current candidate";
    }),
  ),
);
export type SfStatusSnapshot = typeof SfStatusSnapshot.Type;

export const SfControlSuccessResult = Schema.Struct({
  command: SfControlCommand,
  snapshot: SfStatusSnapshot,
});
export type SfControlSuccessResult = typeof SfControlSuccessResult.Type;

export const sfControlErrorCodes = [
  "unsupported_version",
  "invalid_request",
  "correlation_conflict",
  "invalid_state",
  "seat_unavailable",
  "takeover_timeout",
  "lease_not_held",
  // One code for every rejected recovery verb. The old pair named the two commands they belonged to, and both
  // commands are gone: `continue`, `rerun`, and `resume` are refused for the same reason — the outstanding
  // attention does not permit the verb, or there is nothing outstanding to resolve.
  "recovery_not_available",
  // A mutating command arrived without a credential that verifies against the daemon's provisioned verifier.
  // `status` is exempt, so observation never needs one ("Workflow actions have role-aware adapters" (ADR 0038)).
  "unauthorized",
  "bebop_unavailable",
  "internal_error",
] as const;
export const SfControlErrorCode = Schema.Literals(sfControlErrorCodes);
export type SfControlErrorCode = typeof SfControlErrorCode.Type;

const SfControlErrorMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.sfControlMessageMaxLength), Schema.isTrimmed()),
);
export const SfControlError = Schema.Struct({
  code: SfControlErrorCode,
  message: SfControlErrorMessage,
});
export type SfControlError = typeof SfControlError.Type;

export const SfControlSuccessResponse = Schema.Struct({
  type: Schema.Literal("success"),
  controlVersion: SfControlVersion,
  correlationId: CorrelationId,
  result: SfControlSuccessResult,
});
export const SfControlErrorResponse = Schema.Struct({
  type: Schema.Literal("error"),
  controlVersion: SfControlVersion,
  correlationId: CorrelationId,
  error: SfControlError,
});
export const SfControlResponse = Schema.Union([SfControlSuccessResponse, SfControlErrorResponse]);
export type SfControlResponse = typeof SfControlResponse.Type;
