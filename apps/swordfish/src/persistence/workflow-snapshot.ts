import {
  AttentionKind,
  Candidate,
  ConstraintProfile,
  ConstraintScope,
  Controller,
  EffectiveSpec,
  EventSequence,
  GitSha,
  gateStatuses,
  NonNegativeInteger,
  PrivatePreviewAttachment,
  SeatId,
  SeatRole,
  SpecRevision,
  SwordfishStage,
  Timestamp,
} from "@bebop/contracts";
import type { GateStates, ScopeLedgers } from "@bebop/workflow";
import { Schema } from "effect";

import { makeInitialSwordfishWorkflowState, type SwordfishWorkflowState } from "#src/workflow/reducer.ts";

const GateState = Schema.Struct({ status: Schema.Literals(gateStatuses), completedAt: Schema.optionalKey(Timestamp) });
const RetainedFingerprint = Schema.Struct({
  sequence: EventSequence,
  fingerprint: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/))),
});
const ActiveCowboy = Schema.Struct({ role: SeatRole, seatId: SeatId });
const AttentionState = Schema.Struct({ kind: AttentionKind, reason: Schema.String, raisedAt: Timestamp });

/**
 * The attempt in flight, including the mark its wall clock is running from.
 *
 * `runningSince` has to be durable, and this is the field that makes daemon downtime count toward the attempt:
 * after a restart the gap between the last pre-crash event and the first post-restart one is accrued from this
 * mark, with no timer that could have missed it ("Constraint exhaustion is computed, not announced" (ADR 0042)).
 */
const AttemptState = Schema.Struct({
  scope: ConstraintScope,
  role: SeatRole,
  seatId: SeatId,
  ordinal: NonNegativeInteger,
  startedAt: Timestamp,
  turns: NonNegativeInteger,
  turnsGranted: NonNegativeInteger,
  elapsedMs: NonNegativeInteger,
  wallClockGrantedMs: NonNegativeInteger,
  runningSince: Schema.NullOr(Timestamp),
});
const ScopeLedger = Schema.Struct({ attemptsConsumed: NonNegativeInteger, attemptsGranted: NonNegativeInteger });
const ScopeLedgersSchema = Schema.Struct({ building: ScopeLedger, review: ScopeLedger, qa: ScopeLedger });

const SwordfishWorkflowSnapshot = Schema.Struct({
  lastAppliedSequence: EventSequence,
  fingerprints: Schema.Array(RetainedFingerprint),
  fingerprintFloor: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  stage: SwordfishStage,
  suspendedStage: Schema.NullOr(SwordfishStage),
  controller: Controller,
  activeCowboy: Schema.NullOr(ActiveCowboy),
  effectiveSpec: Schema.NullOr(EffectiveSpec),
  candidate: Schema.NullOr(Candidate),
  gates: Schema.Struct({
    local_validation: GateState,
    pr_ci: GateState,
    code_review: GateState,
    qa: GateState,
    evidence_upload: GateState,
  }),
  readinessClaim: Schema.NullOr(Schema.Struct({ candidateSha: GitSha, specRevision: SpecRevision })),
  previews: Schema.Array(PrivatePreviewAttachment),
  attention: Schema.Array(AttentionState),
  // The profile is stored rather than re-read at load. It is frozen for the bounty from the base revision, so
  // reloading it would let a later configuration change silently re-judge an attempt that was already running.
  constraints: ConstraintProfile,
  attempt: Schema.NullOr(AttemptState),
  ledgers: ScopeLedgersSchema,
  validatedCandidatesConsumed: NonNegativeInteger,
});
type SwordfishWorkflowSnapshot = typeof SwordfishWorkflowSnapshot.Type;

export function toWorkflowSnapshot(state: SwordfishWorkflowState): SwordfishWorkflowSnapshot {
  return {
    lastAppliedSequence: state.lastAppliedSequence,
    fingerprints: Object.entries(state.appliedEventFingerprints).map(([sequence, fingerprint]) => ({
      sequence: Number(sequence) as typeof EventSequence.Type,
      fingerprint,
    })),
    fingerprintFloor: state.fingerprintFloor,
    stage: state.stage,
    suspendedStage: state.suspendedStage,
    controller: state.controller,
    activeCowboy: state.activeCowboy,
    effectiveSpec: state.effectiveSpec,
    candidate: state.candidate,
    gates: state.gates,
    readinessClaim: state.readinessClaim,
    previews: state.previews,
    attention: state.attention,
    constraints: state.constraints,
    attempt: state.attempt,
    ledgers: state.ledgers,
    validatedCandidatesConsumed: state.validatedCandidatesConsumed,
  };
}

export function fromWorkflowSnapshot(snapshot: SwordfishWorkflowSnapshot): SwordfishWorkflowState {
  const fingerprints: Record<number, string> = {};
  for (const entry of snapshot.fingerprints) fingerprints[entry.sequence] = entry.fingerprint;
  return {
    ...makeInitialSwordfishWorkflowState(),
    lastAppliedSequence: snapshot.lastAppliedSequence,
    appliedEventFingerprints: fingerprints,
    fingerprintFloor: snapshot.fingerprintFloor,
    stage: snapshot.stage,
    suspendedStage: snapshot.suspendedStage,
    controller: snapshot.controller,
    activeCowboy: snapshot.activeCowboy,
    effectiveSpec: snapshot.effectiveSpec,
    candidate: snapshot.candidate,
    gates: snapshot.gates as GateStates,
    readinessClaim: snapshot.readinessClaim,
    previews: snapshot.previews,
    attention: snapshot.attention,
    constraints: snapshot.constraints,
    attempt: snapshot.attempt,
    ledgers: snapshot.ledgers as ScopeLedgers,
    validatedCandidatesConsumed: snapshot.validatedCandidatesConsumed,
  };
}

export const encodeWorkflowSnapshot = Schema.encodeUnknownSync(SwordfishWorkflowSnapshot);
export const decodeWorkflowSnapshot = Schema.decodeUnknownSync(SwordfishWorkflowSnapshot);
