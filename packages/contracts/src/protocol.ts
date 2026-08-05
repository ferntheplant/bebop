import { Schema } from "effect";

import { PrivatePreviewAttachments } from "./attachments.ts";
import { Candidate } from "./candidate.ts";
import { ContinueCommand, RerunCommand, ResumeCommand, StopCommand, TakeoverCommand } from "./commands.ts";
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
  AttemptOutcome,
  AttentionKind,
  CandidateGate,
  CandidateInvalidationReason,
  ControlChangeReason,
  Controller,
  GateOutcome,
  RerunTarget,
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
 *
 * `target` rides here rather than on an event of its own, because a recovery grant is not a separate thing that
 * happens — it is what resolving a `constraint_exhausted` by `rerun` *means*
 * ("Constraint exhaustion is computed, not announced" (ADR 0042)). It is required for `rerun` and forbidden
 * otherwise: a rerun with no target names neither the scope it grants an attempt in nor the record it clears
 * (ADR 0043), and a target on any other resolution would grant nothing while implying it had.
 */
const AttentionClearedEventBase = Schema.Struct({
  type: Schema.Literal("attention_cleared"),
  resolution: WorkflowResolution,
  target: Schema.optionalKey(RerunTarget),
});
export const AttentionClearedEvent = AttentionClearedEventBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof AttentionClearedEventBase.Type>((event) => {
      if (event.resolution === "rerun") {
        return event.target === undefined
          ? { path: ["target"], issue: "Expected a rerun to name its target" }
          : undefined;
      }
      return event.target === undefined
        ? undefined
        : { path: ["target"], issue: `Expected no target on a ${event.resolution} resolution` };
    }),
  ),
);

/**
 * One Swordfish-controlled cowboy assignment began.
 *
 * It carries nothing. The scope is the active cowboy's role, the ordinal is the reducer's own count, and the
 * start instant is the message's `occurredAt`, so every field this could have declared is one the reducer
 * already knows and would have had to check. What it does assert is that a cowboy is active: an attempt is one
 * cowboy assignment, so the reducer rejects this event when there is nobody to assign.
 */
export const AttemptStartedEvent = Schema.Struct({
  type: Schema.Literal("attempt_started"),
});

/**
 * One model step finished.
 *
 * A completed step consumes a turn whether it requested tools or finished with prose; provider transport retries
 * and failed requests are not steps and produce no event. Turns are the budget dimension with no timing gap,
 * because every increment is itself an event — which is why only wall clock needs a wake-up
 * ("Constraint exhaustion is computed, not announced" (ADR 0042)).
 */
export const TurnCompletedEvent = Schema.Struct({
  type: Schema.Literal("turn_completed"),
});

/**
 * The attempt finished, and whether it produced anything.
 *
 * An attempt that exhausted its watchdogs while allowance remains ends here and the next one starts
 * automatically. The *final* allowed attempt is not ended: it is preserved in its seat behind
 * `needs_attention` so that `continue` has something to revive
 * ("Continue preserves an attempt; rerun replaces it" (ADR 0041)).
 */
export const AttemptEndedEvent = Schema.Struct({
  type: Schema.Literal("attempt_ended"),
  outcome: AttemptOutcome,
  detail: Schema.optionalKey(ProtocolMessage),
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
  AttemptStartedEvent,
  TurnCompletedEvent,
  AttemptEndedEvent,
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
export { ContinueCommand, RerunCommand, ResumeCommand, StopCommand, TakeoverCommand };

export const BebopCommand = Schema.Union([
  StopCommand,
  TakeoverCommand,
  HandoffCommand,
  ContinueCommand,
  RerunCommand,
  ResumeCommand,
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
