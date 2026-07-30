import { EventMessage, type SwordfishEvent } from "@bebop/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  makeInitialSwordfishWorkflowState,
  reduceSwordfishWorkflow,
  type SwordfishWorkflowState,
} from "#src/workflow/reducer.ts";

import goldenReplay from "./golden-replay-v1.json" with { type: "json" };

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

function apply(state: SwordfishWorkflowState, sequence: number, event: typeof SwordfishEvent.Encoded) {
  const result = reduceSwordfishWorkflow(state, message(sequence, event));
  if (!result.ok) {
    throw new Error(`Reducer rejected ${result.error.type}`);
  }
  return result.state;
}

function throughPushedCandidate(): SwordfishWorkflowState {
  let state = makeInitialSwordfishWorkflowState();
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

describe("Swordfish workflow reducer", () => {
  test("replays the committed workflow transcript idempotently", () => {
    let state = makeInitialSwordfishWorkflowState();
    for (const [index, event] of goldenReplay.entries()) {
      state = apply(state, index + 1, event as typeof SwordfishEvent.Encoded);
    }
    expect(state.stage).toBe("ready");

    const finalMessage = message(goldenReplay.length, goldenReplay.at(-1) as typeof SwordfishEvent.Encoded);
    const duplicate = reduceSwordfishWorkflow(state, finalMessage);
    expect(duplicate).toEqual({ ok: true, applied: false, reason: "already_applied", state });

    const oldCollision = reduceSwordfishWorkflow(
      state,
      message(1, { type: "attention_required", reason: "conflicting old replay" }),
    );
    expect(oldCollision).toMatchObject({ ok: false, error: { type: "sequence_collision", sequence: 1 } });

    const gap = reduceSwordfishWorkflow(
      state,
      message(goldenReplay.length + 2, { type: "attention_required", reason: "gap" }),
    );
    expect(gap).toMatchObject({ ok: false, error: { type: "sequence_gap", expected: 10, received: 11 } });
  });

  test("applies the legal pipeline to an exact-SHA readiness claim", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, {
      type: "gate_completed",
      gate: "pr_ci",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    state = apply(state, 6, {
      type: "gate_completed",
      gate: "code_review",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    state = apply(state, 7, { type: "stage_changed", stage: "qa_running" });
    state = apply(state, 8, {
      type: "gate_completed",
      gate: "qa",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    const readyEvent = {
      type: "gate_completed",
      gate: "evidence_upload",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    } as const;
    state = apply(state, 9, readyEvent);

    expect(state.stage).toBe("ready");
    expect(state.readinessClaim).toEqual({ candidateSha, specRevision: 1 });

    const duplicate = reduceSwordfishWorkflow(state, message(9, readyEvent));
    expect(duplicate).toEqual({ ok: true, applied: false, reason: "already_applied", state });
    const collision = reduceSwordfishWorkflow(state, message(9, { type: "attention_required", reason: "conflict" }));
    expect(collision).toMatchObject({ ok: false, error: { type: "sequence_collision", sequence: 9 } });

    state = apply(state, 10, {
      type: "candidate_invalidated",
      candidateSha,
      specRevision: 1,
      reason: "branch_head_changed",
    });
    expect(state.readinessClaim).toBeNull();
    expect(state.candidate).toBeNull();
    expect(Object.values(state.gates).every((gate) => gate.status === "not_started")).toBe(true);
  });

  test("accepts CI and review completion in either order", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, {
      type: "gate_completed",
      gate: "code_review",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    expect(state.stage).toBe("pr_ci");
    state = apply(state, 6, {
      type: "gate_completed",
      gate: "pr_ci",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    expect(state.stage).toBe("qa_preparing");
  });

  test("rejects gaps, skipped transitions, and stale candidate results", () => {
    const initial = makeInitialSwordfishWorkflowState();
    const gap = reduceSwordfishWorkflow(initial, message(2, { type: "effective_spec_set", spec }));
    expect(gap).toMatchObject({ ok: false, error: { type: "sequence_gap", expected: 1, received: 2 } });

    const candidateBeforeSpec = reduceSwordfishWorkflow(
      initial,
      message(1, { type: "candidate_submitted", candidate }),
    );
    expect(candidateBeforeSpec).toMatchObject({ ok: false, error: { type: "illegal_transition" } });

    const pushed = throughPushedCandidate();
    const stale = reduceSwordfishWorkflow(
      pushed,
      message(5, {
        type: "gate_completed",
        gate: "pr_ci",
        candidateSha: "c".repeat(40),
        specRevision: 1,
        outcome: "passed",
      }),
    );
    expect(stale).toMatchObject({ ok: false, error: { type: "candidate_mismatch" } });
  });

  test("invalidates every candidate-bound result", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, {
      type: "candidate_invalidated",
      candidateSha,
      specRevision: 1,
      reason: "new_commit",
      observedHeadSha: "c".repeat(40),
    });

    expect(state.stage).toBe("revision");
    expect(state.candidate).toBeNull();
    expect(state.readinessClaim).toBeNull();
    expect(Object.values(state.gates).every((gate) => gate.status === "not_started")).toBe(true);
  });

  test("preserves human control while invalidating the suspended workflow", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, { type: "stage_changed", stage: "human_controlled" });
    state = apply(state, 6, {
      type: "candidate_invalidated",
      candidateSha,
      specRevision: 1,
      reason: "new_commit",
    });

    expect(state.stage).toBe("human_controlled");
    expect(state.suspendedStage).toBe("revision");
    state = apply(state, 7, { type: "stage_changed", stage: "revision" });
    expect(state.stage).toBe("revision");
  });

  test("requires the first effective spec to begin at revision one", () => {
    const result = reduceSwordfishWorkflow(
      makeInitialSwordfishWorkflowState(),
      message(1, { type: "effective_spec_set", spec: { ...spec, revision: 7 } }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { type: "spec_revision_mismatch", expected: 1, received: 7 },
    });
  });

  test("resumes the underlying stage after repeated attention events", () => {
    let state = makeInitialSwordfishWorkflowState();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "attention_required", reason: "Inspect the repository." });
    expect(state).toMatchObject({ stage: "needs_attention", suspendedStage: "implementing" });
    state = apply(state, 3, { type: "attention_required", reason: "Still blocked." });
    expect(state).toMatchObject({ stage: "needs_attention", suspendedStage: "implementing" });
    state = apply(state, 4, { type: "stage_changed", stage: "implementing" });
    expect(state).toMatchObject({ stage: "implementing", suspendedStage: null });
  });

  test("preserves the pre-takeover stage when attention arrives during human control", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, { type: "stage_changed", stage: "human_controlled" });
    state = apply(state, 6, { type: "attention_required", reason: "Inspect the running gate." });
    expect(state).toMatchObject({ stage: "human_controlled", suspendedStage: "pushed_candidate" });
    state = apply(state, 7, { type: "stage_changed", stage: "needs_attention" });
    expect(state).toMatchObject({ stage: "needs_attention", suspendedStage: "pushed_candidate" });
    state = apply(state, 8, { type: "stage_changed", stage: "pushed_candidate" });
    expect(state).toMatchObject({ stage: "pushed_candidate", suspendedStage: null });
  });
});
