// The Swordfish workflow transition core (`docs/design/SYSTEM.md` §12.1).
//
// Both Swordfish and Bebop apply the same event stream and must reach the same conclusion
// about stage, gates, candidate, and attention. This module is the single interpretation of
// those events; it is pure, and it knows nothing about SQLite, Postgres, sockets, or
// connection freshness. Bebop's connection and freshness scoping wraps it rather than
// re-implementing it, because that scoping is Bebop's genuinely distinct concern.
//
// Before this package existed the two copies had already drifted: Swordfish recorded
// `attentionReason` from a `stage_changed -> needs_attention` event and Bebop did not, so a
// bounty could report `needs_attention` to the CLI with a blank reason.

import { createHash } from "node:crypto";

import type { EventMessage, SwordfishStage } from "@bebop/contracts";
import { EventMessage as EventMessageSchema, toEventSequence } from "@bebop/contracts";
import { Schema } from "effect";

import { fingerprintWindow, initialGates, type GateStates, type WorkflowCoreState } from "#src/state.ts";

export type WorkflowError =
  | { readonly type: "sequence_gap"; readonly expected: number; readonly received: number }
  | { readonly type: "sequence_collision"; readonly sequence: number }
  | { readonly type: "fingerprint_missing"; readonly sequence: number; readonly floor: number }
  | { readonly type: "illegal_transition"; readonly stage: SwordfishStage | null; readonly eventType: string }
  | { readonly type: "spec_revision_mismatch"; readonly expected: number; readonly received: number }
  | { readonly type: "candidate_mismatch"; readonly expectedSha: string | null; readonly receivedSha: string }
  | { readonly type: "gate_not_pending"; readonly gate: string; readonly status: string };

/**
 * Why an event changed nothing. The distinction is load-bearing rather than diagnostic: it
 * is what tells a gateway whether it may acknowledge.
 *
 * - `already_applied` — seen before, verified identical. Safe to acknowledge; not
 *   acknowledging it loops replay forever.
 * - `unverifiable_replay` — at or below the applied frontier but its fingerprint has been
 *   pruned, so identity could not be confirmed. Still safe to acknowledge, because the
 *   sequence is behind the frontier, but the caller knows the check did not run.
 */
export type WorkflowSkipReason = "already_applied" | "unverifiable_replay";

export type WorkflowResult<S> =
  | { readonly ok: true; readonly applied: true; readonly state: S }
  | { readonly ok: true; readonly applied: false; readonly reason: WorkflowSkipReason; readonly state: S }
  | { readonly ok: false; readonly error: WorkflowError };

/**
 * A short content hash of the encoded event.
 *
 * The previous implementation retained the complete re-encoded JSON of every event, so a
 * long bounty stored each event twice in durable state. Only identity is ever compared, so
 * a hash carries the whole signal at a fixed 32 bytes.
 */
export function eventFingerprint(message: EventMessage): string {
  const encoded = JSON.stringify(Schema.encodeSync(EventMessageSchema)(message));
  return createHash("sha256").update(encoded).digest("hex").slice(0, 32);
}

/**
 * Stages during which the workflow is suspended: progress is recorded as the stage to
 * resume into rather than applied to `stage` directly.
 *
 * `cancelling` is in this set because in-flight hooks and CI polls legitimately land after
 * a stop command. Without it a late `gate_completed` moved a cancelling run to `revision`
 * and the cancellation was lost.
 */
function isSuspended(stage: SwordfishStage | null): boolean {
  return stage === "human_controlled" || stage === "needs_attention" || stage === "blocked" || stage === "cancelling";
}

function isTerminal(stage: SwordfishStage | null): boolean {
  return stage === "cancelled" || stage === "failed";
}

function stageChanges(state: WorkflowCoreState, nextStage: SwordfishStage): Partial<WorkflowCoreState> {
  return isSuspended(state.stage) ? { suspendedStage: nextStage } : { stage: nextStage };
}

function attentionChanges(state: WorkflowCoreState): Partial<WorkflowCoreState> {
  if (state.stage === "human_controlled" || state.stage === "needs_attention") {
    return {};
  }
  return { stage: "needs_attention", suspendedStage: state.suspendedStage ?? state.stage };
}

function gateStage(gates: GateStates): SwordfishStage {
  if (gates.pr_ci.status === "failed" || gates.code_review.status === "failed") {
    return "revision";
  }
  if (gates.pr_ci.status === "passed" && gates.code_review.status === "passed") {
    return "qa_preparing";
  }
  if (gates.pr_ci.status === "passed") {
    return "code_review";
  }
  if (gates.code_review.status === "passed") {
    return "pr_ci";
  }
  return "pushed_candidate";
}

function illegal(state: WorkflowCoreState, eventType: string): WorkflowError {
  return { type: "illegal_transition", stage: state.stage, eventType };
}

/**
 * Computes the core field changes for one event, or the error that rejects it.
 *
 * Returning changes rather than a whole state is what lets both apps keep their own extra
 * fields without either of them re-deciding what an event means.
 */
function changesFor(
  state: WorkflowCoreState,
  message: EventMessage,
):
  | { readonly ok: true; readonly changes: Partial<WorkflowCoreState> }
  | { readonly ok: false; readonly error: WorkflowError } {
  const event = message.event;

  switch (event.type) {
    case "effective_spec_set": {
      // Bebop's projection may still be at `null` because it has not heard from this
      // Swordfish yet; Swordfish itself is at `interactive`.
      if (state.stage !== null && state.stage !== "interactive" && state.stage !== "human_controlled") {
        return { ok: false, error: illegal(state, event.type) };
      }
      const expected = (state.effectiveSpec?.revision ?? 0) + 1;
      if (event.spec.revision !== expected) {
        return {
          ok: false,
          error: { type: "spec_revision_mismatch", expected, received: event.spec.revision },
        };
      }
      return {
        ok: true,
        changes: {
          stage: "implementing",
          suspendedStage: null,
          effectiveSpec: event.spec,
          candidate: null,
          gates: initialGates(),
          readinessClaim: null,
          attentionReason: null,
        },
      };
    }

    case "candidate_submitted": {
      if (state.stage !== "implementing" && state.stage !== "revision") {
        return { ok: false, error: illegal(state, event.type) };
      }
      if (state.effectiveSpec === null || event.candidate.specRevision !== state.effectiveSpec.revision) {
        return {
          ok: false,
          error: {
            type: "spec_revision_mismatch",
            expected: state.effectiveSpec?.revision ?? 0,
            received: event.candidate.specRevision,
          },
        };
      }
      return {
        ok: true,
        changes: {
          stage: "local_validation",
          candidate: event.candidate,
          gates: { ...initialGates(), local_validation: { status: "pending" } },
          readinessClaim: null,
        },
      };
    }

    case "gate_completed": {
      if (state.candidate === null || state.candidate.commitSha !== event.candidateSha) {
        return {
          ok: false,
          error: {
            type: "candidate_mismatch",
            expectedSha: state.candidate?.commitSha ?? null,
            receivedSha: event.candidateSha,
          },
        };
      }
      if (state.candidate.specRevision !== event.specRevision) {
        return {
          ok: false,
          error: {
            type: "spec_revision_mismatch",
            expected: state.candidate.specRevision,
            received: event.specRevision,
          },
        };
      }
      const current = state.gates[event.gate];
      if (current.status !== "pending") {
        return { ok: false, error: { type: "gate_not_pending", gate: event.gate, status: current.status } };
      }
      const gates: GateStates = {
        ...state.gates,
        [event.gate]: { status: event.outcome, completedAt: message.occurredAt },
      };
      if (event.outcome === "failed") {
        return { ok: true, changes: { gates, ...stageChanges(state, "revision"), readinessClaim: null } };
      }
      if (event.gate === "local_validation") {
        return { ok: true, changes: { gates } };
      }
      if (event.gate === "pr_ci" || event.gate === "code_review") {
        return { ok: true, changes: { gates, ...stageChanges(state, gateStage(gates)) } };
      }
      if (event.gate === "qa") {
        return {
          ok: true,
          changes: {
            gates: { ...gates, evidence_upload: { status: "pending" } },
            ...stageChanges(state, "evidence_upload"),
          },
        };
      }
      return {
        ok: true,
        changes: {
          gates,
          ...stageChanges(state, "ready"),
          readinessClaim: { candidateSha: event.candidateSha, specRevision: event.specRevision },
        },
      };
    }

    case "candidate_invalidated": {
      if (state.candidate === null || state.candidate.commitSha !== event.candidateSha) {
        return {
          ok: false,
          error: {
            type: "candidate_mismatch",
            expectedSha: state.candidate?.commitSha ?? null,
            receivedSha: event.candidateSha,
          },
        };
      }
      if (state.candidate.specRevision !== event.specRevision) {
        return {
          ok: false,
          error: {
            type: "spec_revision_mismatch",
            expected: state.candidate.specRevision,
            received: event.specRevision,
          },
        };
      }
      return {
        ok: true,
        changes: {
          ...stageChanges(state, "revision"),
          candidate: null,
          gates: initialGates(),
          readinessClaim: null,
        },
      };
    }

    case "stage_changed": {
      // Resuming the exact stage that was suspended clears the suspension and the reason
      // that produced it.
      if (isSuspended(state.stage) && state.suspendedStage === event.stage) {
        return { ok: true, changes: { stage: event.stage, suspendedStage: null, attentionReason: null } };
      }
      // The first event is Swordfish announcing its initial state. Swordfish starts at
      // `interactive`, while Bebop's projection starts at null; accepting the announcement
      // in both states lets the same durable event pass through both reducers.
      if (
        event.stage === "interactive" &&
        (state.stage === null || (state.stage === "interactive" && state.lastAppliedSequence === 0))
      ) {
        return { ok: true, changes: { stage: "interactive" } };
      }
      if (event.stage === "pushed_candidate") {
        return state.stage === "local_validation" && state.gates.local_validation.status === "passed"
          ? {
              ok: true,
              changes: {
                stage: "pushed_candidate",
                gates: { ...state.gates, pr_ci: { status: "pending" }, code_review: { status: "pending" } },
              },
            }
          : { ok: false, error: illegal(state, event.type) };
      }
      if (event.stage === "qa_running") {
        return state.stage === "qa_preparing"
          ? { ok: true, changes: { stage: "qa_running", gates: { ...state.gates, qa: { status: "pending" } } } }
          : { ok: false, error: illegal(state, event.type) };
      }
      if (event.stage === "human_controlled" || event.stage === "needs_attention" || event.stage === "blocked") {
        if (isTerminal(state.stage)) {
          return { ok: false, error: illegal(state, event.type) };
        }
        const attentionReason =
          event.stage === "needs_attention" ? (event.reason ?? state.attentionReason) : state.attentionReason;
        // Leaving human control for attention or a block does not record a new stage to
        // resume into: the one already recorded is still the work that was interrupted.
        return state.stage === "human_controlled" && event.stage !== "human_controlled"
          ? { ok: true, changes: { stage: event.stage, attentionReason } }
          : {
              ok: true,
              changes: {
                stage: event.stage,
                suspendedStage: state.suspendedStage ?? state.stage,
                attentionReason,
              },
            };
      }
      if (event.stage === "cancelling" && !isTerminal(state.stage)) {
        return { ok: true, changes: { stage: "cancelling" } };
      }
      if (event.stage === "cancelled" && state.stage === "cancelling") {
        return { ok: true, changes: { stage: "cancelled", suspendedStage: null } };
      }
      if (event.stage === "failed" && state.stage !== "cancelled") {
        return { ok: true, changes: { stage: "failed", suspendedStage: null } };
      }
      return { ok: false, error: illegal(state, event.type) };
    }

    case "lease_changed":
      return {
        ok: true,
        changes: { leases: { ...state.leases, [event.seat]: { seatId: event.seatId, owner: event.owner } } },
      };

    case "attachments_updated":
      return { ok: true, changes: { previews: event.previews } };

    case "attention_required":
      return { ok: true, changes: { ...attentionChanges(state), attentionReason: event.reason } };
  }
}

/** Retains fingerprints only for the window still reachable by replay. */
function pruneFingerprints(
  fingerprints: Readonly<Record<number, string>>,
  appliedSequence: number,
): { readonly retained: Record<number, string>; readonly floor: number } {
  const floor = Math.max(1, appliedSequence - fingerprintWindow + 1);
  const retained: Record<number, string> = {};
  for (const [key, value] of Object.entries(fingerprints)) {
    if (Number(key) >= floor) {
      retained[Number(key)] = value;
    }
  }
  return { retained, floor };
}

/**
 * Applies one event to any state that carries the core fields.
 *
 * The generic parameter is what lets Bebop keep `connectionId`, `freshness`, and
 * `lastProducedSequence` on the same value the core updates, without the core knowing they
 * exist.
 */
export function applyWorkflowEvent<S extends WorkflowCoreState>(state: S, message: EventMessage): WorkflowResult<S> {
  const retained = state.appliedEventFingerprints[message.sequence];
  if (retained !== undefined && retained !== eventFingerprint(message)) {
    return { ok: false, error: { type: "sequence_collision", sequence: message.sequence } };
  }

  if (message.sequence <= state.lastAppliedSequence) {
    if (retained !== undefined) {
      return { ok: true, applied: false, reason: "already_applied", state };
    }
    // Below the retention floor the identity check cannot run. That is a deliberate,
    // bounded weakening and the caller is told about it; inside the window a missing
    // fingerprint means the state itself is inconsistent, which is not.
    return message.sequence < state.fingerprintFloor
      ? { ok: true, applied: false, reason: "unverifiable_replay", state }
      : {
          ok: false,
          error: { type: "fingerprint_missing", sequence: message.sequence, floor: state.fingerprintFloor },
        };
  }

  const expected = state.lastAppliedSequence + 1;
  if (message.sequence !== expected) {
    return { ok: false, error: { type: "sequence_gap", expected, received: message.sequence } };
  }
  if (isTerminal(state.stage)) {
    return { ok: false, error: illegal(state, message.event.type) };
  }

  const outcome = changesFor(state, message);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }

  const { retained: fingerprints, floor } = pruneFingerprints(
    { ...state.appliedEventFingerprints, [message.sequence]: eventFingerprint(message) },
    message.sequence,
  );

  return {
    ok: true,
    applied: true,
    // The core writes only core fields, and never writes null to `stage`, so an app that
    // narrows `stage` to non-null keeps that guarantee. TypeScript cannot see this because
    // the core's own `stage` is the wider nullable type.
    state: {
      ...state,
      ...outcome.changes,
      lastAppliedSequence: toEventSequence(message.sequence),
      appliedEventFingerprints: fingerprints,
      fingerprintFloor: floor,
    } as unknown as S,
  };
}
