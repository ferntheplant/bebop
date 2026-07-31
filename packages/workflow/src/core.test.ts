// Covers the behaviours an early review of this core found wrong or unbounded. The transition
// rules that were already correct are exercised through the two app reducers, which now
// share this core.

import { EventMessage, type SwordfishStage, type SwordfishEvent } from "@bebop/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { applyWorkflowEvent, fingerprintWindow, initialWorkflowCoreState, type WorkflowCoreState } from "#src/index.ts";

const timestamp = "2026-07-26T12:34:56.000Z";
const candidateSha = "b".repeat(40);

const spec = {
  revision: 1,
  title: "Implement replay",
  goal: "Replay durable events safely.",
  context: [],
  constraints: [],
  nonGoals: [],
  acceptanceCriteria: [{ id: "ac-1", description: "Duplicate events are no-ops." }],
  suggestedQaScenarios: [{ description: "Reconnect", expectedOutcome: "No duplicate state change." }],
  createdFromSeatId: "seat-ein",
  createdAt: timestamp,
} as const;

const candidate = {
  commitSha: candidateSha,
  specRevision: 1,
  summary: "Implement reducer replay handling.",
  claimedLocalChecks: [],
  activeDevelopmentServers: [],
  knownLimitations: [],
  disposition: "candidate_ready",
} as const;

interface TestState extends WorkflowCoreState {
  readonly stage: SwordfishStage;
}

function initial(): TestState {
  return { ...initialWorkflowCoreState(), stage: "interactive" };
}

function message(sequence: number, event: typeof SwordfishEvent.Encoded) {
  return Schema.decodeUnknownSync(EventMessage)({
    type: "event",
    protocolVersion: 1,
    bountyId: "bty-01jz8j3d9f4x",
    vmId: "vm_01JZ8J3D9F4X",
    sequence,
    occurredAt: timestamp,
    event,
  });
}

function apply(state: TestState, sequence: number, event: typeof SwordfishEvent.Encoded): TestState {
  const result = applyWorkflowEvent(state, message(sequence, event));
  if (!result.ok) {
    throw new Error(`Core rejected ${result.error.type}`);
  }
  return result.state;
}

/** Reaches `pushed_candidate` with `pr_ci` and `code_review` both pending. */
function throughPushedCandidate(): TestState {
  let state = initial();
  state = apply(state, 1, { type: "effective_spec_set", spec });
  state = apply(state, 2, { type: "candidate_submitted", candidate });
  state = apply(state, 3, {
    type: "gate_completed",
    gate: "local_validation",
    candidateSha,
    specRevision: 1,
    outcome: "passed",
  });
  return apply(state, 4, { type: "stage_changed", stage: "pushed_candidate" });
}

describe("workflow core", () => {
  test("accepts a first interactive announcement from a projection that has heard nothing", () => {
    // Bebop's projection starts at `null` because it has not met this Swordfish yet, and the
    // first thing a Swordfish says about itself is that it is interactive. Rejecting that as
    // an illegal transition would leave `bounty status` reporting `provisioning` for a bounty
    // whose crew is already talking to the user.
    const fresh: WorkflowCoreState = { ...initialWorkflowCoreState(), stage: null };
    const result = applyWorkflowEvent(fresh, message(1, { type: "stage_changed", stage: "interactive" }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.applied && result.state.stage).toBe("interactive");
  });

  test("still refuses a redundant interactive announcement once a stage is known", () => {
    // Swordfish itself starts at `interactive`, so this branch must not become a general
    // licence to jump back to the beginning from anywhere.
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    const result = applyWorkflowEvent(state, message(2, { type: "stage_changed", stage: "interactive" }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.type).toBe("illegal_transition");
  });

  test("records an attention reason arriving via stage_changed", () => {
    // The drift that made this package necessary: Swordfish recorded this reason and
    // Bebop's projection did not, so a needs_attention bounty showed the CLI a blank
    // reason whenever it arrived on stage_changed rather than attention_required.
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "stage_changed", stage: "needs_attention", reason: "hook is missing" });

    expect(state.stage).toBe("needs_attention");
    expect(state.attentionReason).toBe("hook is missing");
    expect(state.suspendedStage).toBe("implementing");
  });

  test("clears the attention reason when the suspended stage resumes", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "stage_changed", stage: "needs_attention", reason: "hook is missing" });
    state = apply(state, 3, { type: "stage_changed", stage: "implementing" });

    expect(state.stage).toBe("implementing");
    expect(state.suspendedStage).toBeNull();
    expect(state.attentionReason).toBeNull();
  });

  test("a late gate result cannot resurrect a cancelling run", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, { type: "stage_changed", stage: "cancelling" });

    // In-flight hooks and CI polls legitimately land after a stop command. A failed gate
    // must carry the feedback that explains it, or the contract rejects the event.
    state = apply(state, 6, {
      type: "gate_completed",
      gate: "pr_ci",
      candidateSha,
      specRevision: 1,
      outcome: "failed",
      feedback: { kind: "external_ci", checks: [{ name: "build", outcome: "failed" }] },
    });

    expect(state.stage).toBe("cancelling");
    expect(state.suspendedStage).toBe("revision");
    expect(state.gates.pr_ci.status).toBe("failed");

    state = apply(state, 7, { type: "stage_changed", stage: "cancelled" });
    expect(state.stage).toBe("cancelled");
  });

  test("retains fingerprints only within the replay window", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    for (let sequence = 2; sequence <= fingerprintWindow + 10; sequence += 1) {
      state = apply(state, sequence, { type: "attention_required", reason: `attention ${sequence}` });
    }

    const retained = Object.keys(state.appliedEventFingerprints).map(Number);
    expect(retained.length).toBe(fingerprintWindow);
    expect(state.fingerprintFloor).toBe(fingerprintWindow + 10 - fingerprintWindow + 1);
    expect(Math.min(...retained)).toBe(state.fingerprintFloor);
  });

  test("distinguishes a verified duplicate from one whose fingerprint was pruned", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    for (let sequence = 2; sequence <= fingerprintWindow + 10; sequence += 1) {
      state = apply(state, sequence, { type: "attention_required", reason: `attention ${sequence}` });
    }

    const recent = applyWorkflowEvent(
      state,
      message(state.lastAppliedSequence, {
        type: "attention_required",
        reason: `attention ${state.lastAppliedSequence}`,
      }),
    );
    expect(recent).toMatchObject({ ok: true, applied: false, reason: "already_applied" });

    // Sequence 1 is long behind the frontier and its fingerprint is gone, so identity
    // cannot be confirmed. Still safe to acknowledge, but the caller is told the check
    // did not run rather than being handed a silent pass.
    const pruned = applyWorkflowEvent(state, message(1, { type: "effective_spec_set", spec }));
    expect(pruned).toMatchObject({ ok: true, applied: false, reason: "unverifiable_replay" });
  });

  test("still fails closed on a conflicting replay inside the window", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "candidate_submitted", candidate });

    const conflicting = applyWorkflowEvent(state, message(2, { type: "attention_required", reason: "conflict" }));
    expect(conflicting).toMatchObject({ ok: false, error: { type: "sequence_collision", sequence: 2 } });
  });

  test("reports a missing fingerprint inside the window rather than passing it", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "candidate_submitted", candidate });

    // A state whose retention claims to cover sequence 2 but does not is inconsistent,
    // not a pruning artefact, and must not be treated as an idempotent no-op.
    const corrupted: TestState = { ...state, appliedEventFingerprints: {} };
    const result = applyWorkflowEvent(corrupted, message(2, { type: "candidate_submitted", candidate }));
    expect(result).toMatchObject({ ok: false, error: { type: "fingerprint_missing", sequence: 2, floor: 1 } });
  });
});
