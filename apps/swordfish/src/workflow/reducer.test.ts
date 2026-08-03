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
  test("records the initial interactive announcement", () => {
    const result = reduceSwordfishWorkflow(
      makeInitialSwordfishWorkflowState(),
      message(1, { type: "stage_changed", stage: "interactive" }),
    );

    expect(result.ok && result.applied).toBe(true);
    if (result.ok) expect(result.state.lastAppliedSequence).toBe(1);
  });

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
      message(1, { type: "attention_required", kind: "operational", reason: "conflicting old replay" }),
    );
    expect(oldCollision).toMatchObject({ ok: false, error: { type: "sequence_collision", sequence: 1 } });

    const gap = reduceSwordfishWorkflow(
      state,
      message(goldenReplay.length + 2, { type: "attention_required", kind: "operational", reason: "gap" }),
    );
    expect(gap).toMatchObject({
      ok: false,
      error: { type: "sequence_gap", expected: goldenReplay.length + 1, received: goldenReplay.length + 2 },
    });

    // The transcript carries the seat lifecycle, so replaying it also proves the whole bounty ran with never
    // more than one cowboy active ("One controller drives one active cowboy" (ADR 0037)) and that review only
    // ever followed CI ("CI gates cowboy review" (ADR 0040)).
    expect(state.activeCowboy).toBeNull();
    expect(state.controller).toBe("swordfish");
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
    const collision = reduceSwordfishWorkflow(
      state,
      message(9, { type: "attention_required", kind: "operational", reason: "conflict" }),
    );
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

  test("requires CI to pass before review may complete", () => {
    // This replaces a test that asserted the opposite. "CI gates cowboy review" (ADR 0040) retired the parallel
    // join: spending jet's turns on a candidate that deterministic checks may already reject is waste, and the
    // validated-candidate allowance is meant to count SHAs that reached review, not SHAs that were pushed.
    let state = throughPushedCandidate();
    expect(state.gates.code_review.status).toBe("not_started");

    const early = reduceSwordfishWorkflow(
      state,
      message(5, {
        type: "gate_completed",
        gate: "code_review",
        candidateSha,
        specRevision: 1,
        outcome: "passed",
      }),
    );
    expect(early).toMatchObject({ ok: false, error: { type: "gate_not_pending", gate: "code_review" } });

    state = apply(state, 5, {
      type: "gate_completed",
      gate: "pr_ci",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    expect(state.stage).toBe("code_review");
    expect(state.gates.code_review.status).toBe("pending");

    state = apply(state, 6, {
      type: "gate_completed",
      gate: "code_review",
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

  test("invalidation moves the stage under human control rather than around it", () => {
    // Control is orthogonal to stage ("One controller drives one active cowboy" (ADR 0037)), so work reported
    // during a human-control episode lands on `stage` directly. The old model suspended it and needed a second
    // transition to unpack, which briefly returned authority to Swordfish.
    let state = throughPushedCandidate();
    state = apply(state, 5, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    state = apply(state, 6, { type: "control_changed", controller: "human", reason: "takeover" });
    state = apply(state, 7, {
      type: "candidate_invalidated",
      candidateSha,
      specRevision: 1,
      reason: "new_commit",
    });

    expect(state.stage).toBe("revision");
    expect(state.suspendedStage).toBeNull();
    expect(state.controller).toBe("human");
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
    state = apply(state, 2, { type: "attention_required", kind: "operational", reason: "Inspect the repository." });
    expect(state).toMatchObject({ stage: "needs_attention", suspendedStage: "implementing" });
    // A second reason replaces the first; the stage that was interrupted is still the one to come back to.
    state = apply(state, 3, { type: "attention_required", kind: "operational", reason: "Still blocked." });
    expect(state).toMatchObject({ stage: "needs_attention", suspendedStage: "implementing" });
    expect(state.attention).toMatchObject({ reason: "Still blocked." });
    state = apply(state, 4, { type: "attention_cleared", resolution: "resume" });
    expect(state).toMatchObject({ stage: "implementing", suspendedStage: null, attention: null });
  });

  test("attention during human control suspends the work without releasing control", () => {
    // Two independent dimensions: attention suspends the stage, and the human stays responsible for it.
    let state = throughPushedCandidate();
    state = apply(state, 5, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    state = apply(state, 6, { type: "control_changed", controller: "human", reason: "takeover" });
    state = apply(state, 7, { type: "attention_required", kind: "operational", reason: "Inspect the running gate." });
    expect(state).toMatchObject({
      stage: "needs_attention",
      suspendedStage: "pushed_candidate",
      controller: "human",
    });
    state = apply(state, 8, { type: "attention_cleared", resolution: "resume" });
    expect(state).toMatchObject({ stage: "pushed_candidate", suspendedStage: null, controller: "human" });
    // Handing off returns the same work to Swordfish, unchanged (ADR 0036).
    state = apply(state, 9, { type: "control_changed", controller: "swordfish", reason: "handoff" });
    expect(state).toMatchObject({ stage: "pushed_candidate", controller: "swordfish" });
  });
});
