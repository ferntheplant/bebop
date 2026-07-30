import {
  Candidate,
  EffectiveSpec,
  EventSequence,
  GitSha,
  gateStatuses,
  LeaseOwner,
  PrivatePreviewAttachment,
  SeatId,
  SpecRevision,
  SwordfishStage,
  Timestamp,
} from "@bebop/contracts";
import type { GateStates } from "@bebop/workflow";
import { Schema } from "effect";

import { makeInitialSwordfishWorkflowState, type SwordfishWorkflowState } from "#src/workflow/reducer.ts";

const GateState = Schema.Struct({ status: Schema.Literals(gateStatuses), completedAt: Schema.optionalKey(Timestamp) });
const RetainedFingerprint = Schema.Struct({
  sequence: EventSequence,
  fingerprint: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/))),
});
const SeatLeaseState = Schema.Struct({ seatId: SeatId, owner: LeaseOwner });

export const SwordfishWorkflowSnapshot = Schema.Struct({
  lastAppliedSequence: EventSequence,
  fingerprints: Schema.Array(RetainedFingerprint),
  fingerprintFloor: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  stage: SwordfishStage,
  suspendedStage: Schema.NullOr(SwordfishStage),
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
  leases: Schema.Struct({
    ein: Schema.optionalKey(SeatLeaseState),
    jet: Schema.optionalKey(SeatLeaseState),
    faye: Schema.optionalKey(SeatLeaseState),
  }),
  previews: Schema.Array(PrivatePreviewAttachment),
  attentionReason: Schema.NullOr(Schema.String),
});
export type SwordfishWorkflowSnapshot = typeof SwordfishWorkflowSnapshot.Type;

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
    effectiveSpec: state.effectiveSpec,
    candidate: state.candidate,
    gates: state.gates,
    readinessClaim: state.readinessClaim,
    leases: state.leases,
    previews: state.previews,
    attentionReason: state.attentionReason,
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
    effectiveSpec: snapshot.effectiveSpec,
    candidate: snapshot.candidate,
    gates: snapshot.gates as GateStates,
    readinessClaim: snapshot.readinessClaim,
    leases: snapshot.leases,
    previews: snapshot.previews,
    attentionReason: snapshot.attentionReason,
  };
}

export const encodeWorkflowSnapshot = Schema.encodeUnknownSync(SwordfishWorkflowSnapshot);
export const decodeWorkflowSnapshot = Schema.decodeUnknownSync(SwordfishWorkflowSnapshot);
