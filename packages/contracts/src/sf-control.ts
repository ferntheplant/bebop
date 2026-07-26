import { Schema } from "effect";

import { PrivatePreviewAttachments } from "./attachments.ts";
import { ConstraintKey } from "./constraints.ts";
import {
  RetryStageCommand,
  StopCommand,
  SwordfishEvent,
  TakeoverCommand,
  ExtendConstraintCommand,
} from "./protocol.ts";
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
import { CandidateGate, GateStatus, LeaseOwner, SeatRole, SwordfishStage } from "./workflow.ts";

export const currentSfControlVersion = 1 as const;
export const SfControlVersion = Schema.Literal(currentSfControlVersion);
export type SfControlVersion = typeof SfControlVersion.Type;

export const SfStatusCommand = Schema.Struct({ type: Schema.Literal("status") });
export const SfHandbackCommand = Schema.Struct({ type: Schema.Literal("handback") });
export const SfApproveConfigCommand = Schema.Struct({ type: Schema.Literal("approve_config") });
export const SfControlCommand = Schema.Union([
  SfStatusCommand,
  StopCommand,
  TakeoverCommand,
  SfHandbackCommand,
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

export const SfSeatSnapshot = Schema.Struct({
  role: SeatRole,
  seatId: SeatId,
  leaseOwner: LeaseOwner,
});
export type SfSeatSnapshot = typeof SfSeatSnapshot.Type;

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
  effectiveSpecRevision: Schema.optionalKey(SpecRevision),
  activeSeat: Schema.optionalKey(SeatRole),
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
      const seatRoles = new Set(snapshot.seats.map((seat) => seat.role));
      const seatIds = new Set(snapshot.seats.map((seat) => seat.seatId));
      if (seatRoles.size !== snapshot.seats.length || seatIds.size !== snapshot.seats.length) {
        return "Expected unique Swordfish seat roles and IDs";
      }
      if (snapshot.activeSeat !== undefined && !seatRoles.has(snapshot.activeSeat)) {
        return "Expected the active seat to exist in the seat snapshot";
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
