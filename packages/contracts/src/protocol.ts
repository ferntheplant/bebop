import { Schema } from "effect";

import { PrivatePreviewAttachments } from "./attachments.ts";
import { Candidate } from "./candidate.ts";
import { ExtendConstraintCommand, RetryStageCommand, StopCommand, TakeoverCommand } from "./commands.ts";
import {
  EvidenceUploadCommittedMessage,
  EvidenceUploadFinalizeMessage,
  EvidenceUploadOfferMessage,
  EvidenceUploadRejectedMessage,
  EvidenceUploadRequiredMessage,
} from "./evidence-upload.ts";
import { GateFeedback, isFeedbackForGate } from "./feedback.ts";
import {
  BountyId,
  CommandId,
  ConnectionId,
  EventSequence,
  GitSha,
  ProducedEventSequence,
  ProtocolVersion,
  SeatId,
  SpecRevision,
  Timestamp,
  VmId,
} from "./scalars.ts";
import { schemaLimits } from "./settings.ts";
import { EffectiveSpec } from "./spec.ts";
import {
  CandidateGate,
  CandidateInvalidationReason,
  GateOutcome,
  LeaseOwner,
  SeatRole,
  SwordfishStage,
} from "./workflow.ts";

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

export const CandidateReady = Schema.Struct({
  ...Candidate.fields,
  disposition: Schema.Literal("candidate_ready"),
});

export const CandidateSubmittedEvent = Schema.Struct({
  type: Schema.Literal("candidate_submitted"),
  candidate: CandidateReady,
});

export const AttentionRequiredEvent = Schema.Struct({
  type: Schema.Literal("attention_required"),
  reason: ProtocolMessage,
});

export const AttachmentsUpdatedEvent = Schema.Struct({
  type: Schema.Literal("attachments_updated"),
  previews: PrivatePreviewAttachments,
});

const GateCompletedEventBase = Schema.Struct({
  type: Schema.Literal("gate_completed"),
  gate: CandidateGate,
  candidateSha: GitSha,
  specRevision: SpecRevision,
  outcome: GateOutcome,
  feedback: Schema.optionalKey(GateFeedback),
});

/**
 * A gate outcome, with the structured result that produced it.
 *
 * Two rules are enforced here rather than left to the implementation:
 *
 * 1. **A failed gate must carry feedback.** A failure with no explanation cannot be
 *    returned to ein as a revision packet (`docs/capabilities/06-autonomous-implementation.md`), so the schema refuses it.
 *    A stage whose agent produced nothing usable says so with `kind: "unstructured"` and a
 *    reason — that is the detectable error, and it is not the same value as an empty
 *    findings list.
 * 2. **The feedback must match the gate.** Review findings cannot arrive on a QA gate.
 *
 * A passed gate may still carry feedback: non-blocking review findings ride along and are
 * summarised at ready time (`docs/capabilities/09-code-review.md`).
 */
export const GateCompletedEvent = GateCompletedEventBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof GateCompletedEventBase.Type>((event) => {
      if (event.outcome === "failed" && event.feedback === undefined) {
        return { path: ["feedback"], issue: "Expected a failed gate to carry structured feedback" };
      }
      return event.feedback === undefined || isFeedbackForGate(event.gate, event.feedback)
        ? undefined
        : { path: ["feedback"], issue: `Expected feedback matching the ${event.gate} gate` };
    }),
  ),
);

export const CandidateInvalidatedEvent = Schema.Struct({
  type: Schema.Literal("candidate_invalidated"),
  candidateSha: GitSha,
  specRevision: SpecRevision,
  reason: CandidateInvalidationReason,
  observedHeadSha: Schema.optionalKey(GitSha),
});

export const SwordfishEvent = Schema.Union([
  StageChangedEvent,
  LeaseChangedEvent,
  EffectiveSpecSetEvent,
  CandidateSubmittedEvent,
  AttentionRequiredEvent,
  AttachmentsUpdatedEvent,
  GateCompletedEvent,
  CandidateInvalidatedEvent,
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

export const HandbackCommand = Schema.Struct({
  type: Schema.Literal("handback"),
  seat: SeatRole,
});

export const ApproveConfigCommand = Schema.Struct({
  type: Schema.Literal("approve_config"),
  candidateSha: GitSha,
});

export const ExternalCiCompletedCommand = Schema.Struct({
  type: Schema.Literal("external_ci_completed"),
  candidateSha: GitSha,
  specRevision: SpecRevision,
  outcome: GateOutcome,
});

// Re-exported so a consumer of the protocol does not need to know which payloads are
// shared with the local `sf` socket. `commands.ts` records what that sharing costs.
export { ExtendConstraintCommand, RetryStageCommand, StopCommand, TakeoverCommand };

export const BebopCommand = Schema.Union([
  StopCommand,
  TakeoverCommand,
  HandbackCommand,
  ExtendConstraintCommand,
  RetryStageCommand,
  ApproveConfigCommand,
  ExternalCiCompletedCommand,
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
