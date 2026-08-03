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
  AttentionKind,
  CandidateGate,
  CandidateInvalidationReason,
  ControlChangeReason,
  Controller,
  GateOutcome,
  SeatRole,
  SwordfishStage,
  WorkflowResolution,
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

/**
 * Control passed between Swordfish and a human ("Control passes through a quiescent handoff" (ADR 0036)).
 *
 * Deliberately carries no stage: takeover and handoff change who is responsible for the current work, not what
 * the work is ("One controller drives one active cowboy" (ADR 0037)).
 */
export const ControlChangedEvent = Schema.Struct({
  type: Schema.Literal("control_changed"),
  controller: Controller,
  reason: ControlChangeReason,
  detail: Schema.optionalKey(ProtocolMessage),
});

/**
 * A cowboy seat became the active one, or the active one stood down.
 *
 * At most one may be active (ADR 0037), which the reducer enforces rather than trusting the emitter: activating
 * a second one while a first is active is an illegal transition, not a silent replacement. Deactivation carries
 * the role so a stale event cannot retire a seat that already replaced it.
 */
export const CowboyActivatedEvent = Schema.Struct({
  type: Schema.Literal("cowboy_activated"),
  seat: SeatRole,
  seatId: SeatId,
});

export const CowboyDeactivatedEvent = Schema.Struct({
  type: Schema.Literal("cowboy_deactivated"),
  seat: SeatRole,
  seatId: SeatId,
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

/**
 * The bounty stopped and needs a human.
 *
 * The `kind` is what makes the attention actionable: `resolutionsForAttention` turns it into the exact set of
 * commands that may clear it ("Workflow actions have role-aware adapters" (ADR 0038)). Those commands are
 * derived on read rather than carried here, so a record cannot claim an exit its kind does not permit.
 */
export const AttentionRequiredEvent = Schema.Struct({
  type: Schema.Literal("attention_required"),
  kind: AttentionKind,
  reason: ProtocolMessage,
});

/**
 * The attention was resolved, by the named action.
 *
 * The reducer refuses a resolution the raised kind does not permit, which is what stops a generic `resume` from
 * clearing a budget exhaustion.
 */
export const AttentionClearedEvent = Schema.Struct({
  type: Schema.Literal("attention_cleared"),
  resolution: WorkflowResolution,
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
  ControlChangedEvent,
  CowboyActivatedEvent,
  CowboyDeactivatedEvent,
  EffectiveSpecSetEvent,
  CandidateSubmittedEvent,
  AttentionRequiredEvent,
  AttentionClearedEvent,
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

/**
 * Release human control.
 *
 * Carries no seat: a human-control episode covers the whole workflow rather than one seat, and it may outlive
 * the cowboy it started with ("One controller drives one active cowboy" (ADR 0037)). The local `sf` command
 * never took a seat argument either, so naming one here only invented a way for the two to disagree.
 */
export const HandoffCommand = Schema.Struct({
  type: Schema.Literal("handoff"),
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
  HandoffCommand,
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
