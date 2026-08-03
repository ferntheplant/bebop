// The durable encoding of Bebop's Swordfish projection ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)).
//
// The projection is a decoded domain value: it holds `DateTime.Utc` timestamps, branded
// identifiers, and a nested effective spec. None of that survives `JSON.stringify` on its
// own, so the snapshot has a schema and is decoded at the persistence boundary like every
// other external representation (see `AGENTS.md`, architectural rules).
//
// Rebuilding the projection by replaying `swordfish_events` would also work, and is the
// repair path if a snapshot is ever unreadable. It is not the load path: a long-running
// bounty would re-run its whole event history on every reconnect.

import type { EventSequence } from "@bebop/contracts";
import {
  AttentionKind,
  Candidate,
  Controller,
  EffectiveSpec,
  EventSequence as EventSequenceSchema,
  GitSha,
  gateStatuses,
  PrivatePreviewAttachment,
  SeatId,
  SeatRole,
  SpecRevision,
  SwordfishStage,
  Timestamp,
} from "@bebop/contracts";
import type { GateStates, WorkflowCoreState } from "@bebop/workflow";
import { initialWorkflowCoreState } from "@bebop/workflow";
import { Schema } from "effect";

const GateState = Schema.Struct({
  status: Schema.Literals(gateStatuses),
  completedAt: Schema.optionalKey(Timestamp),
});

const GateStatesSchema = Schema.Struct({
  local_validation: GateState,
  pr_ci: GateState,
  code_review: GateState,
  qa: GateState,
  evidence_upload: GateState,
});

const ActiveCowboy = Schema.Struct({ role: SeatRole, seatId: SeatId });
const AttentionState = Schema.Struct({ kind: AttentionKind, reason: Schema.String, raisedAt: Timestamp });

/**
 * Retained event fingerprints, as a list rather than a map.
 *
 * The in-memory form is `Record<number, string>`, but JSON object keys are strings, so a
 * map schema would have to decide how a numeric key round-trips. A list of pairs has one
 * obvious encoding and no such question.
 */
const RetainedFingerprint = Schema.Struct({
  sequence: EventSequenceSchema,
  fingerprint: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/))),
});

export const WorkflowSnapshot = Schema.Struct({
  lastAppliedSequence: EventSequenceSchema,
  fingerprints: Schema.Array(RetainedFingerprint),
  fingerprintFloor: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  stage: Schema.NullOr(SwordfishStage),
  suspendedStage: Schema.NullOr(SwordfishStage),
  controller: Controller,
  activeCowboy: Schema.NullOr(ActiveCowboy),
  effectiveSpec: Schema.NullOr(EffectiveSpec),
  candidate: Schema.NullOr(Candidate),
  gates: GateStatesSchema,
  readinessClaim: Schema.NullOr(Schema.Struct({ candidateSha: GitSha, specRevision: SpecRevision })),
  previews: Schema.Array(PrivatePreviewAttachment),
  attention: Schema.NullOr(AttentionState),
});
export type WorkflowSnapshot = typeof WorkflowSnapshot.Type;

export function toWorkflowSnapshot(state: WorkflowCoreState): WorkflowSnapshot {
  return {
    lastAppliedSequence: state.lastAppliedSequence,
    fingerprints: Object.entries(state.appliedEventFingerprints).map(([sequence, fingerprint]) => ({
      sequence: Number(sequence) as EventSequence,
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

export function fromWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowCoreState {
  const appliedEventFingerprints: Record<number, string> = {};
  for (const entry of snapshot.fingerprints) {
    appliedEventFingerprints[entry.sequence] = entry.fingerprint;
  }
  return {
    ...initialWorkflowCoreState(),
    lastAppliedSequence: snapshot.lastAppliedSequence,
    appliedEventFingerprints,
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

export const encodeWorkflowSnapshot = Schema.encodeUnknownSync(WorkflowSnapshot);
export const decodeWorkflowSnapshot = Schema.decodeUnknownSync(WorkflowSnapshot);
