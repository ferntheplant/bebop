import { Schema } from "effect";

import { PrivatePreviewAttachments } from "./attachments.ts";
import { ExtendConstraintCommand, RetryStageCommand, StopCommand, TakeoverCommand } from "./commands.ts";
import { ConstraintKey } from "./constraints.ts";
import { SwordfishEvent } from "./protocol.ts";
import {
  BountyId,
  ConstraintLimit,
  CorrelationId,
  EventSequence,
  GitRef,
  GitSha,
  NonNegativeInteger,
  ProducedEventSequence,
  RepositorySlug,
  SeatId,
  SpecRevision,
  Timestamp,
  VmId,
  WorkflowRevision,
} from "./scalars.ts";
import { schemaLimits } from "./settings.ts";
import {
  AttentionKind,
  CandidateGate,
  Controller,
  GateStatus,
  resolutionsForAttention,
  SeatRole,
  SwordfishStage,
  WorkflowResolution,
} from "./workflow.ts";

export const currentSfControlVersion = 1 as const;
export const SfControlVersion = Schema.Literal(currentSfControlVersion);
export type SfControlVersion = typeof SfControlVersion.Type;

export const SfStatusCommand = Schema.Struct({ type: Schema.Literal("status") });
export const SfHandoffCommand = Schema.Struct({ type: Schema.Literal("handoff") });
export const SfApproveConfigCommand = Schema.Struct({ type: Schema.Literal("approve_config") });
export const SfControlCommand = Schema.Union([
  SfStatusCommand,
  StopCommand,
  TakeoverCommand,
  SfHandoffCommand,
  ExtendConstraintCommand,
  RetryStageCommand,
  SfApproveConfigCommand,
]);
export type SfControlCommand = typeof SfControlCommand.Type;

export const SfControlRequest = Schema.Struct({
  type: Schema.Literal("request"),
  controlVersion: SfControlVersion,
  correlationId: CorrelationId,
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

/** One reason the bounty stopped, with the exact commands that clear it (`docs/capabilities/05-control-lease-and-takeover.md`). */
export const SfAttentionSnapshot = Schema.Struct({
  kind: AttentionKind,
  reason: Schema.String,
  resolutions: Schema.Array(WorkflowResolution).pipe(Schema.check(Schema.isMinLength(1))),
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

export const SfConstraintSnapshot = Schema.Struct({
  constraint: ConstraintKey,
  consumed: NonNegativeInteger,
  limit: ConstraintLimit,
  extensionsGranted: NonNegativeInteger,
});
export type SfConstraintSnapshot = typeof SfConstraintSnapshot.Type;

export const SfPendingConfigApproval = Schema.Struct({
  candidateSha: GitSha,
  unifiedDiff: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.sfUnifiedDiffMaxLength)),
  ),
});
export type SfPendingConfigApproval = typeof SfPendingConfigApproval.Type;

export const SfBebopConnectionSnapshot = Schema.Struct({
  state: Schema.Literals(["connected", "disconnected"]),
  lastContactAt: Schema.optionalKey(Timestamp),
  acknowledgedThrough: EventSequence,
  pendingEventCount: NonNegativeInteger,
});
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
  constraints: Schema.Array(SfConstraintSnapshot),
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
        if (record.resolutions.some((resolution) => !permitted.includes(resolution))) {
          return "Expected every offered resolution to be permitted by the attention kind";
        }
      }
      const gates = new Set(snapshot.gates.map((gate) => gate.gate));
      if (gates.size !== snapshot.gates.length) {
        return "Expected unique candidate gates";
      }
      const constraints = new Set(snapshot.constraints.map((constraint) => constraint.constraint));
      if (constraints.size !== snapshot.constraints.length) {
        return "Expected unique constraint ledger entries";
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
  "constraint_extension_not_allowed",
  "stage_retry_not_allowed",
  "config_approval_not_pending",
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
