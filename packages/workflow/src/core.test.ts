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

/** Reaches `pushed_candidate` with only `pr_ci` pending — review opens when CI passes (ADR 0040). */
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

const ciPassed = {
  type: "gate_completed",
  gate: "pr_ci",
  candidateSha,
  specRevision: 1,
  outcome: "passed",
} as const;

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

  test("attention suspends the stage it interrupted and records why", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "attention_required", kind: "agent_blocked", reason: "hook is missing" });

    expect(state.stage).toBe("needs_attention");
    expect(state.suspendedStage).toBe("implementing");
    expect(state.attention).toMatchObject([{ kind: "agent_blocked", reason: "hook is missing" }]);
  });

  test("a permitted resolution restores the suspended stage", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "attention_required", kind: "agent_blocked", reason: "hook is missing" });
    state = apply(state, 3, { type: "attention_cleared", resolution: "resume" });

    expect(state.stage).toBe("implementing");
    expect(state.suspendedStage).toBeNull();
    expect(state.attention).toEqual([]);
  });

  test("a generic resume cannot clear an exhausted budget", () => {
    // The point of giving attention a kind (ADR 0038): `resume` changes no allowance, so it must not be able to
    // revive an attempt whose watchdogs ran out. That recovery is `continue` or `rerun`, and it is a grant.
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, {
      type: "attention_required",
      kind: "constraint_exhausted",
      reason: "primary turn budget exhausted",
    });

    const resumed = applyWorkflowEvent(state, message(3, { type: "attention_cleared", resolution: "resume" }));
    expect(resumed).toMatchObject({
      ok: false,
      error: { type: "resolution_not_permitted", kind: "constraint_exhausted", resolution: "resume" },
    });

    const continued = apply(state, 3, { type: "attention_cleared", resolution: "continue" });
    expect(continued.stage).toBe("implementing");
    expect(continued.attention).toEqual([]);
  });

  test("a later reason cannot widen the exits of an outstanding stricter one", () => {
    // An `operational` attention raised by startup reconciliation used to replace an outstanding
    // `constraint_exhausted`. Because `operational` permits `resume`, the exhausted attempt could then be
    // revived with no grant, which is exactly what ADR 0038 and ADR 0041 forbid.
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, {
      type: "attention_required",
      kind: "constraint_exhausted",
      reason: "primary turn budget exhausted",
    });
    state = apply(state, 3, {
      type: "attention_required",
      kind: "operational",
      reason: "Startup reconciliation found 1 uncertain operation.",
    });
    expect(state.attention.map((record) => record.kind)).toEqual(["constraint_exhausted", "operational"]);

    // `resume` clears the operational reason it is permitted to clear, and only that one.
    state = apply(state, 4, { type: "attention_cleared", resolution: "resume" });
    expect(state.stage).toBe("needs_attention");
    expect(state.attention.map((record) => record.kind)).toEqual(["constraint_exhausted"]);

    // The budget still needs its own grant, and only then does the work resume.
    state = apply(state, 5, { type: "attention_cleared", resolution: "continue" });
    expect(state.stage).toBe("implementing");
    expect(state.attention).toEqual([]);
  });

  test("a restatement of the same kind replaces rather than accumulating", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "attention_required", kind: "operational", reason: "first" });
    state = apply(state, 3, { type: "attention_required", kind: "operational", reason: "second" });

    expect(state.attention).toHaveLength(1);
    expect(state.attention[0]).toMatchObject({ kind: "operational", reason: "second" });
  });

  test("a resolution no outstanding reason permits is refused", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "attention_required", kind: "environment", reason: "the VM is unreachable" });

    const result = applyWorkflowEvent(state, message(3, { type: "attention_cleared", resolution: "resume" }));
    expect(result).toMatchObject({
      ok: false,
      error: { type: "resolution_not_permitted", kind: "environment", resolution: "resume" },
    });
  });

  test("clearing attention nobody raised is refused", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });

    const result = applyWorkflowEvent(state, message(2, { type: "attention_cleared", resolution: "resume" }));
    expect(result).toMatchObject({ ok: false, error: { type: "no_attention_raised" } });
  });

  test("attention raised while cancelling does not make the cancellation resumable", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, { type: "stage_changed", stage: "cancelling" });
    state = apply(state, 6, { type: "attention_required", kind: "environment", reason: "the VM is unreachable" });

    expect(state.stage).toBe("cancelling");
    expect(state.attention).toMatchObject([{ kind: "environment" }]);

    // Clearing it drops the reason without reviving the run.
    state = apply(state, 7, { type: "attention_cleared", resolution: "cancel" });
    expect(state.stage).toBe("cancelling");
    expect(state.attention).toEqual([]);
  });

  test("takeover changes the controller and leaves the stage alone", () => {
    // The whole of ADR 0037 in one assertion: taking over during review used to look like leaving review.
    let state = throughPushedCandidate();
    state = apply(state, 5, { ...ciPassed });
    state = apply(state, 6, { type: "cowboy_activated", seat: "jet", seatId: "seat-jet-1" });
    expect(state.stage).toBe("code_review");

    state = apply(state, 7, { type: "control_changed", controller: "human", reason: "takeover" });
    expect(state.controller).toBe("human");
    expect(state.stage).toBe("code_review");
    expect(state.suspendedStage).toBeNull();

    state = apply(state, 8, { type: "control_changed", controller: "swordfish", reason: "handoff" });
    expect(state.controller).toBe("swordfish");
    expect(state.stage).toBe("code_review");
  });

  test("takeover is refused when no cowboy is active", () => {
    // Deterministic stages run without a cowboy (ADR 0037), and there is nothing to take over from a CI poll.
    const state = throughPushedCandidate();
    const result = applyWorkflowEvent(
      state,
      message(5, { type: "control_changed", controller: "human", reason: "takeover" }),
    );
    expect(result).toMatchObject({ ok: false, error: { type: "illegal_transition" } });
  });

  test("a second cowboy cannot be activated while one is active", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });

    const second = applyWorkflowEvent(
      state,
      message(3, { type: "cowboy_activated", seat: "jet", seatId: "seat-jet-1" }),
    );
    expect(second).toMatchObject({
      ok: false,
      error: { type: "cowboy_already_active", active: "ein", requested: "jet" },
    });

    // Re-announcing the same seat is how ein's durable seat is reused across attempts.
    const same = apply(state, 3, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    expect(same.activeCowboy).toMatchObject({ role: "ein", seatId: "seat-ein" });
  });

  test("a stale deactivation cannot retire the seat that replaced it", () => {
    // Every jet attempt gets a fresh seat (ADR 0037), so a late deactivation from the previous attempt arrives
    // with the same role and a different ID.
    let state = throughPushedCandidate();
    state = apply(state, 5, { ...ciPassed });
    state = apply(state, 6, { type: "cowboy_activated", seat: "jet", seatId: "seat-jet-2" });

    const stale = applyWorkflowEvent(
      state,
      message(7, { type: "cowboy_deactivated", seat: "jet", seatId: "seat-jet-1" }),
    );
    expect(stale).toMatchObject({ ok: false, error: { type: "cowboy_not_active", requested: "jet" } });

    const current = apply(state, 7, { type: "cowboy_deactivated", seat: "jet", seatId: "seat-jet-2" });
    expect(current.activeCowboy).toBeNull();
  });

  test("review cannot be recorded for a candidate whose CI has not passed", () => {
    // ADR 0040. Previously both gates opened at push time and either could land first, so a review result for a
    // SHA that never reached CI was accepted and simply produced a different stage.
    const state = throughPushedCandidate();
    expect(state.gates.pr_ci.status).toBe("pending");
    expect(state.gates.code_review.status).toBe("not_started");

    const early = applyWorkflowEvent(
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
  });

  test("passing CI is what opens review", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, { ...ciPassed });

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

  test("a failed CI gate sends the candidate to revision without opening review", () => {
    let state = throughPushedCandidate();
    state = apply(state, 5, {
      type: "gate_completed",
      gate: "pr_ci",
      candidateSha,
      specRevision: 1,
      outcome: "failed",
      feedback: { kind: "external_ci", checks: [{ name: "build", outcome: "failed" }] },
    });

    expect(state.stage).toBe("revision");
    expect(state.gates.code_review.status).toBe("not_started");
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
      state = apply(state, sequence, {
        type: "attention_required",
        kind: "operational",
        reason: `attention ${sequence}`,
      });
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
      state = apply(state, sequence, {
        type: "attention_required",
        kind: "operational",
        reason: `attention ${sequence}`,
      });
    }

    const recent = applyWorkflowEvent(
      state,
      message(state.lastAppliedSequence, {
        type: "attention_required",
        kind: "operational",
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

    const conflicting = applyWorkflowEvent(
      state,
      message(2, { type: "attention_required", kind: "operational", reason: "conflict" }),
    );
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
