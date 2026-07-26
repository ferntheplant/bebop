import { Schema } from "effect";

import { PrivatePreviewAttachments } from "./attachments.ts";
import { Candidate } from "./candidate.ts";
import { ConstraintKey } from "./constraints.ts";
import {
  EvidenceUploadCommittedMessage,
  EvidenceUploadFinalizeMessage,
  EvidenceUploadOfferMessage,
  EvidenceUploadRejectedMessage,
  EvidenceUploadRequiredMessage,
} from "./evidence-upload.ts";
import {
  BountyId,
  CommandId,
  ConnectionId,
  EventSequence,
  GitSha,
  ProducedEventSequence,
  ProtocolVersion,
  SeatId,
  Timestamp,
  VmId,
} from "./scalars.ts";
import { schemaLimits } from "./settings.ts";
import { EffectiveSpec } from "./spec.ts";
import { LeaseOwner, SeatRole, SwordfishStage, VerificationStage } from "./workflow.ts";

const ProtocolMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.protocolMessageMaxLength), Schema.isTrimmed()),
);
const ComponentVersion = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.protocolComponentVersionMaxLength),
    Schema.isTrimmed(),
  ),
);

export const RegisterMessage = Schema.Struct({
  type: Schema.Literal("register"),
  protocolVersion: ProtocolVersion,
  bountyId: BountyId,
  vmId: VmId,
  swordfishVersion: ComponentVersion,
  lastProducedEventSequence: EventSequence,
});
export type RegisterMessage = typeof RegisterMessage.Type;

export const RegisteredMessage = Schema.Struct({
  type: Schema.Literal("registered"),
  protocolVersion: ProtocolVersion,
  connectionId: ConnectionId,
  bountyId: BountyId,
  vmId: VmId,
  serverTime: Timestamp,
  acknowledgedThrough: EventSequence,
});
export type RegisteredMessage = typeof RegisteredMessage.Type;

export const HeartbeatMessage = Schema.Struct({
  type: Schema.Literal("heartbeat"),
  protocolVersion: ProtocolVersion,
  bountyId: BountyId,
  vmId: VmId,
  sentAt: Timestamp,
  lastProducedEventSequence: EventSequence,
  lastAppliedCommandId: Schema.optionalKey(CommandId),
});
export type HeartbeatMessage = typeof HeartbeatMessage.Type;

export const StageChangedEvent = Schema.Struct({
  type: Schema.Literal("stage_changed"),
  stage: SwordfishStage,
  reason: Schema.optionalKey(ProtocolMessage),
});

export const LeaseChangedEvent = Schema.Struct({
  type: Schema.Literal("lease_changed"),
  seat: SeatRole,
  seatId: SeatId,
  owner: LeaseOwner,
});

export const EffectiveSpecSetEvent = Schema.Struct({
  type: Schema.Literal("effective_spec_set"),
  spec: EffectiveSpec,
});

export const CandidateSubmittedEvent = Schema.Struct({
  type: Schema.Literal("candidate_submitted"),
  candidate: Candidate,
});

export const AttentionRequiredEvent = Schema.Struct({
  type: Schema.Literal("attention_required"),
  reason: ProtocolMessage,
});

export const AttachmentsUpdatedEvent = Schema.Struct({
  type: Schema.Literal("attachments_updated"),
  previews: PrivatePreviewAttachments,
});

export const SwordfishEvent = Schema.Union([
  StageChangedEvent,
  LeaseChangedEvent,
  EffectiveSpecSetEvent,
  CandidateSubmittedEvent,
  AttentionRequiredEvent,
  AttachmentsUpdatedEvent,
]);
export type SwordfishEvent = typeof SwordfishEvent.Type;

export const EventMessage = Schema.Struct({
  type: Schema.Literal("event"),
  protocolVersion: ProtocolVersion,
  bountyId: BountyId,
  vmId: VmId,
  sequence: ProducedEventSequence,
  occurredAt: Timestamp,
  event: SwordfishEvent,
});
export type EventMessage = typeof EventMessage.Type;

export const EventAcknowledgedMessage = Schema.Struct({
  type: Schema.Literal("event_acknowledged"),
  protocolVersion: ProtocolVersion,
  bountyId: BountyId,
  vmId: VmId,
  acknowledgedThrough: EventSequence,
});
export type EventAcknowledgedMessage = typeof EventAcknowledgedMessage.Type;

export const StopCommand = Schema.Struct({
  type: Schema.Literal("stop"),
  reason: Schema.optionalKey(ProtocolMessage),
});

export const TakeoverCommand = Schema.Struct({
  type: Schema.Literal("takeover"),
  seat: SeatRole,
  force: Schema.Boolean,
});

export const HandbackCommand = Schema.Struct({
  type: Schema.Literal("handback"),
  seat: SeatRole,
});

export const ExtendConstraintCommand = Schema.Struct({
  type: Schema.Literal("extend_constraint"),
  constraint: ConstraintKey,
});

export const RetryStageCommand = Schema.Struct({
  type: Schema.Literal("retry_stage"),
  stage: VerificationStage,
});

export const ApproveConfigCommand = Schema.Struct({
  type: Schema.Literal("approve_config"),
  candidateSha: GitSha,
});

export const BebopCommand = Schema.Union([
  StopCommand,
  TakeoverCommand,
  HandbackCommand,
  ExtendConstraintCommand,
  RetryStageCommand,
  ApproveConfigCommand,
]);
export type BebopCommand = typeof BebopCommand.Type;

export const CommandMessage = Schema.Struct({
  type: Schema.Literal("command"),
  protocolVersion: ProtocolVersion,
  bountyId: BountyId,
  vmId: VmId,
  commandId: CommandId,
  issuedAt: Timestamp,
  command: BebopCommand,
});
export type CommandMessage = typeof CommandMessage.Type;

export const commandResultStatuses = ["accepted", "completed", "rejected", "failed"] as const;
export const CommandResultStatus = Schema.Literals(commandResultStatuses);
export type CommandResultStatus = typeof CommandResultStatus.Type;

export const CommandResultMessage = Schema.Struct({
  type: Schema.Literal("command_result"),
  protocolVersion: ProtocolVersion,
  bountyId: BountyId,
  vmId: VmId,
  commandId: CommandId,
  status: CommandResultStatus,
  reportedAt: Timestamp,
  error: Schema.optionalKey(ProtocolMessage),
});
export type CommandResultMessage = typeof CommandResultMessage.Type;

export const protocolErrorCodes = [
  "unsupported_version",
  "identity_mismatch",
  "invalid_message",
  "sequence_gap",
  "internal_error",
] as const;
export const ProtocolErrorCode = Schema.Literals(protocolErrorCodes);
export type ProtocolErrorCode = typeof ProtocolErrorCode.Type;

export const ProtocolErrorMessage = Schema.Struct({
  type: Schema.Literal("protocol_error"),
  protocolVersion: ProtocolVersion,
  code: ProtocolErrorCode,
  message: ProtocolMessage,
});
export type ProtocolErrorMessage = typeof ProtocolErrorMessage.Type;

export const SwordfishToBebopMessage = Schema.Union([
  RegisterMessage,
  HeartbeatMessage,
  EventMessage,
  CommandResultMessage,
  EvidenceUploadOfferMessage,
  EvidenceUploadFinalizeMessage,
  ProtocolErrorMessage,
]);
export type SwordfishToBebopMessage = typeof SwordfishToBebopMessage.Type;

export const BebopToSwordfishMessage = Schema.Union([
  RegisteredMessage,
  EventAcknowledgedMessage,
  CommandMessage,
  EvidenceUploadRequiredMessage,
  EvidenceUploadCommittedMessage,
  EvidenceUploadRejectedMessage,
  ProtocolErrorMessage,
]);
export type BebopToSwordfishMessage = typeof BebopToSwordfishMessage.Type;
