// The durable encoding of Bebop's Swordfish projection (`docs/design/SYSTEM.md` §9.3).
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
  Candidate,
  EffectiveSpec,
  EventSequence as EventSequenceSchema,
  GitSha,
  gateStatuses,
  LeaseOwner,
  PrivatePreviewAttachment,
  SeatId,
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

const SeatLeaseState = Schema.Struct({ seatId: SeatId, owner: LeaseOwner });

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
  effectiveSpec: Schema.NullOr(EffectiveSpec),
  candidate: Schema.NullOr(Candidate),
  gates: GateStatesSchema,
  readinessClaim: Schema.NullOr(Schema.Struct({ candidateSha: GitSha, specRevision: SpecRevision })),
  leases: Schema.Struct({
    ein: Schema.optionalKey(SeatLeaseState),
    jet: Schema.optionalKey(SeatLeaseState),
    faye: Schema.optionalKey(SeatLeaseState),
  }),
  previews: Schema.Array(PrivatePreviewAttachment),
  attentionReason: Schema.NullOr(Schema.String),
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
    effectiveSpec: state.effectiveSpec,
    candidate: state.candidate,
    gates: state.gates,
    readinessClaim: state.readinessClaim,
    leases: {
      ...(state.leases.ein === undefined ? {} : { ein: state.leases.ein }),
      ...(state.leases.jet === undefined ? {} : { jet: state.leases.jet }),
      ...(state.leases.faye === undefined ? {} : { faye: state.leases.faye }),
    },
    previews: state.previews,
    attentionReason: state.attentionReason,
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
    effectiveSpec: snapshot.effectiveSpec,
    candidate: snapshot.candidate,
    gates: snapshot.gates as GateStates,
    readinessClaim: snapshot.readinessClaim,
    leases: snapshot.leases,
    previews: snapshot.previews,
    attentionReason: snapshot.attentionReason,
  };
}

export const encodeWorkflowSnapshot = Schema.encodeUnknownSync(WorkflowSnapshot);
export const decodeWorkflowSnapshot = Schema.decodeUnknownSync(WorkflowSnapshot);
