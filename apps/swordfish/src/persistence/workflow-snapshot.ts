import {
  AttentionKind,
  Candidate,
  Controller,
  EffectiveSpec,
  EventSequence,
  GitSha,
  gateStatuses,
  PrivatePreviewAttachment,
  SeatId,
  SeatRole,
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
const ActiveCowboy = Schema.Struct({ role: SeatRole, seatId: SeatId });
const AttentionState = Schema.Struct({ kind: AttentionKind, reason: Schema.String, raisedAt: Timestamp });

export const SwordfishWorkflowSnapshot = Schema.Struct({
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
  attention: Schema.NullOr(AttentionState),
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
    controller: state.controller,
    activeCowboy: state.activeCowboy,
    effectiveSpec: state.effectiveSpec,
    candidate: state.candidate,
    gates: state.gates,
    readinessClaim: state.readinessClaim,
    previews: state.previews,
    attention: state.attention,
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
  };
}

export const encodeWorkflowSnapshot = Schema.encodeUnknownSync(SwordfishWorkflowSnapshot);
export const decodeWorkflowSnapshot = Schema.decodeUnknownSync(SwordfishWorkflowSnapshot);
