// Covers the behaviours an early review of this core found wrong or unbounded. The transition
// rules that were already correct are exercised through the two app reducers, which now
// share this core.

import { EventMessage, type SwordfishStage, type SwordfishEvent } from "@bebop/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  applyWorkflowEvent,
  exhaustedConstraints,
  fingerprintWindow,
  initialWorkflowCoreState,
  type WorkflowCoreState,
} from "#src/index.ts";

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

function message(sequence: number, event: typeof SwordfishEvent.Encoded, at: string = timestamp) {
  return Schema.decodeUnknownSync(EventMessage)({
    type: "event",
    protocolVersion: 1,
    bountyId: "bty-01jz8j3d9f4x",
    vmId: "vm_01JZ8J3D9F4X",
    sequence,
    occurredAt: at,
    event,
  });
}

function apply(state: TestState, sequence: number, event: typeof SwordfishEvent.Encoded, at?: string): TestState {
  const result = applyWorkflowEvent(state, message(sequence, event, at));
  if (!result.ok) {
    throw new Error(`Core rejected ${result.error.type}`);
  }
  return result.state;
}

/** `timestamp` advanced by whole minutes, so a test can say how long an attempt ran. */
function minutesLater(count: number): string {
  return new Date(Date.parse(timestamp) + count * 60_000).toISOString();
}

/**
 * An ein attempt whose wall-clock watchdog has genuinely run out, and the attention that reports it.
 *
 * Built rather than asserted, because the reducer refuses a `constraint_exhausted` claim its own arithmetic does
 * not support ("Constraint exhaustion is computed, not announced" (ADR 0042)) — a test that wants an exhausted
 * budget has to spend one.
 */
function throughExhaustedWallClock(): TestState {
  let state = initial();
  state = apply(state, 1, { type: "effective_spec_set", spec });
  state = apply(state, 2, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
  state = apply(state, 3, { type: "attempt_started" });
  // The building watchdog is 90 minutes; this attempt has been running for 91.
  return apply(
    state,
    4,
    { type: "attention_required", kind: "constraint_exhausted", reason: "the ein attempt ran out of wall clock" },
    minutesLater(91),
  );
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
    const state = throughExhaustedWallClock();

    const resumed = applyWorkflowEvent(state, message(5, { type: "attention_cleared", resolution: "resume" }));
    expect(resumed).toMatchObject({
      ok: false,
      error: { type: "resolution_not_permitted", kind: "constraint_exhausted", resolution: "resume" },
    });

    const continued = apply(state, 5, { type: "attention_cleared", resolution: "continue" });
    expect(continued.stage).toBe("implementing");
    expect(continued.attention).toEqual([]);
    // The grant is a whole fresh watchdog pair, not a nudge past the limit, and both dimensions move together so
    // the operator is not asked to revive an attempt that remains blocked by the other one (ADR 0041).
    expect(continued.attempt).toMatchObject({ turnsGranted: 40, wallClockGrantedMs: 90 * 60_000 });
  });

  test("a later reason cannot widen the exits of an outstanding stricter one", () => {
    // An `operational` attention raised by startup reconciliation used to replace an outstanding
    // `constraint_exhausted`. Because `operational` permits `resume`, the exhausted attempt could then be
    // revived with no grant, which is exactly what ADR 0038 and ADR 0041 forbid.
    let state = throughExhaustedWallClock();
    state = apply(state, 5, {
      type: "attention_required",
      kind: "operational",
      reason: "Startup reconciliation found 1 uncertain operation.",
    });
    expect(state.attention.map((record) => record.kind)).toEqual(["constraint_exhausted", "operational"]);

    // `resume` clears the operational reason it is permitted to clear, and only that one.
    state = apply(state, 6, { type: "attention_cleared", resolution: "resume" });
    expect(state.stage).toBe("needs_attention");
    expect(state.attention.map((record) => record.kind)).toEqual(["constraint_exhausted"]);

    // The budget still needs its own grant, and only then does the work resume.
    state = apply(state, 7, { type: "attention_cleared", resolution: "continue" });
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

  test("reopening the spec is not a way out of an attention record", () => {
    // `effective_spec_set` is legal from any stage under human control, and it used to empty attention
    // unconditionally — so `reopen-spec` cleared reasons whose only permitted exit is `cancel`, bypassing the
    // resolution rule entirely (ADR 0038).
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    state = apply(state, 3, { type: "control_changed", controller: "human", reason: "takeover" });
    state = apply(state, 4, { type: "attention_required", kind: "environment", reason: "the VM is unreachable" });

    state = apply(state, 5, { type: "effective_spec_set", spec: { ...spec, revision: 2 } });

    // The new spec applies, but the reason it stopped survives and the work stays suspended behind it.
    expect(state.effectiveSpec?.revision).toBe(2);
    expect(state.stage).toBe("needs_attention");
    expect(state.suspendedStage).toBe("implementing");
    expect(state.attention.map((record) => record.kind)).toEqual(["environment"]);

    // Only the resolution its kind permits releases it, and then the reopened spec is what resumes.
    state = apply(state, 6, { type: "attention_cleared", resolution: "cancel" });
    expect(state.stage).toBe("implementing");
  });

  test("reopening the spec with nothing outstanding resumes immediately", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    state = apply(state, 3, { type: "control_changed", controller: "human", reason: "takeover" });
    state = apply(state, 4, { type: "effective_spec_set", spec: { ...spec, revision: 2 } });

    expect(state.stage).toBe("implementing");
    expect(state.suspendedStage).toBeNull();
    expect(state.attention).toEqual([]);
  });

  test("a terminal transition stands the active cowboy down", () => {
    // Nothing drives a bounty whose loop has ended, and this is the last chance to record it: every event is
    // refused once the stage is terminal, so a later deactivation could never repair the state and `sf status`
    // would mark the seat active forever.
    let state = throughPushedCandidate();
    state = apply(state, 5, { ...ciPassed });
    state = apply(state, 6, { type: "cowboy_activated", seat: "jet", seatId: "seat-jet-1" });
    expect(state.activeCowboy).not.toBeNull();

    state = apply(state, 7, { type: "stage_changed", stage: "cancelling" });
    state = apply(state, 8, { type: "stage_changed", stage: "cancelled" });
    expect(state.stage).toBe("cancelled");
    expect(state.activeCowboy).toBeNull();

    // And the same on the failure path.
    let failing = throughPushedCandidate();
    failing = apply(failing, 5, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    failing = apply(failing, 6, { type: "stage_changed", stage: "failed" });
    expect(failing.activeCowboy).toBeNull();
  });

  test("a seat ID cannot change role while it is the active cowboy", () => {
    // A seat belongs to one cowboy for its whole life. Accepting a role change would leave the reducer
    // disagreeing with the role already recorded against that seat ID in Swordfish's seat table, and the next
    // status read would fail validation for having no matching row.
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "cowboy_activated", seat: "ein", seatId: "seat-shared" });

    const reassigned = applyWorkflowEvent(
      state,
      message(3, { type: "cowboy_activated", seat: "jet", seatId: "seat-shared" }),
    );
    expect(reassigned).toMatchObject({
      ok: false,
      error: { type: "cowboy_already_active", active: "ein", requested: "jet" },
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

describe("constraint ledger", () => {
  /** An ein cowboy at `implementing`, which is the only place an ein attempt may start. */
  function readyToBuild(): TestState {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    return apply(state, 2, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
  }

  test("consumes a scoped attempt slot before the first prompt and refuses one beyond the allowance", () => {
    // The reducer owns the allowance, so a daemon cannot help itself to a fourth attempt against a
    // three-attempt profile. A fourth is a grant, and a grant is a human `rerun` (ADR 0041).
    let state = readyToBuild();
    let sequence = 3;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      state = apply(state, sequence, { type: "attempt_started" });
      expect(state.attempt).toMatchObject({ scope: "building", role: "ein", ordinal: attempt });
      expect(state.ledgers.building.attemptsConsumed).toBe(attempt);
      sequence += 1;
      state = apply(state, sequence, { type: "attempt_ended", outcome: "no_result" });
      sequence += 1;
    }

    const fourth = applyWorkflowEvent(state, message(sequence, { type: "attempt_started" }));
    expect(fourth).toMatchObject({
      ok: false,
      error: { type: "attempts_exhausted", scope: "building", consumed: 3, allowed: 3 },
    });
  });

  test("derives the scope from the cowboy rather than trusting the event to name one", () => {
    // Jet's attempts are charged to review, and nothing on `attempt_started` could have said otherwise: an
    // attempt is one cowboy assignment, so the seat being driven is the scope.
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "cowboy_activated", seat: "jet", seatId: "seat-jet-1" });
    state = apply(state, 3, { type: "attempt_started" });
    expect(state.attempt).toMatchObject({ scope: "review", role: "jet", seatId: "seat-jet-1" });
    expect(state.ledgers).toMatchObject({
      building: { attemptsConsumed: 0 },
      review: { attemptsConsumed: 1 },
      qa: { attemptsConsumed: 0 },
    });
  });

  test("refuses an attempt with no cowboy to assign it to", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    expect(applyWorkflowEvent(state, message(2, { type: "attempt_started" }))).toMatchObject({
      ok: false,
      error: { type: "illegal_transition", eventType: "attempt_started" },
    });
  });

  test("accrues turns and stops counting them under human control", () => {
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    state = apply(state, 4, { type: "turn_completed" });
    state = apply(state, 5, { type: "turn_completed" });
    expect(state.attempt?.turns).toBe(2);

    // Human-controlled turns are unconstrained, so a turn reported after a takeover means the daemon kept
    // prompting after it gave up control. That is a defect, and one loud failure beats an uncounted turn.
    state = apply(state, 6, { type: "control_changed", controller: "human", reason: "takeover" });
    expect(applyWorkflowEvent(state, message(7, { type: "turn_completed" }))).toMatchObject({
      ok: false,
      error: { type: "illegal_transition", eventType: "turn_completed" },
    });
  });

  test("accrues wall clock only while Swordfish is driving unsuspended work", () => {
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    // Ten minutes of autonomous work, then a human takes over for an hour.
    state = apply(state, 4, { type: "turn_completed" }, minutesLater(10));
    expect(state.attempt?.elapsedMs).toBe(10 * 60_000);

    state = apply(state, 5, { type: "control_changed", controller: "human", reason: "takeover" }, minutesLater(10));
    state = apply(state, 6, { type: "control_changed", controller: "swordfish", reason: "handoff" }, minutesLater(70));
    // The hour under human control is charged to nobody. Taking over does not refund the attempt that started,
    // but handing back starts a fresh one, so the old attempt is gone rather than resumed (ADR 0041).
    expect(state.attempt).toBeNull();

    state = apply(state, 7, { type: "attempt_started" }, minutesLater(70));
    state = apply(state, 8, { type: "turn_completed" }, minutesLater(75));
    expect(state.attempt).toMatchObject({ ordinal: 2, elapsedMs: 5 * 60_000 });
  });

  test("excludes the time a bounty spends waiting for a human", () => {
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    state = apply(state, 4, { type: "attention_required", kind: "agent_blocked", reason: "stuck" }, minutesLater(5));
    // Two hours in `needs_attention`, which is longer than the whole 90-minute watchdog. None of it counts.
    state = apply(state, 5, { type: "attention_cleared", resolution: "resume" }, minutesLater(125));
    expect(state.stage).toBe("implementing");
    expect(state.attempt?.elapsedMs).toBe(5 * 60_000);

    state = apply(state, 6, { type: "turn_completed" }, minutesLater(130));
    expect(state.attempt?.elapsedMs).toBe(10 * 60_000);
  });

  test("refuses an exhaustion claim its own accounting does not support", () => {
    // The whole of ADR 0042 in one transition: the daemon says a budget ran out, the reducer has every event and
    // every timestamp, and it disagrees. A skewed clock becomes one failed transition rather than a strangled
    // attempt nobody can explain.
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    state = apply(state, 4, { type: "turn_completed" }, minutesLater(5));

    expect(
      applyWorkflowEvent(
        state,
        message(
          5,
          { type: "attention_required", kind: "constraint_exhausted", reason: "out of time" },
          minutesLater(6),
        ),
      ),
    ).toMatchObject({ ok: false, error: { type: "exhaustion_unsupported" } });

    expect(
      applyWorkflowEvent(state, message(5, { type: "attempt_ended", outcome: "exhausted" }, minutesLater(6))),
    ).toMatchObject({ ok: false, error: { type: "exhaustion_unsupported" } });

    // The same claim at 91 minutes is arithmetic the reducer can vouch for.
    expect(
      applyWorkflowEvent(
        state,
        message(
          5,
          { type: "attention_required", kind: "constraint_exhausted", reason: "out of time" },
          minutesLater(91),
        ),
      ).ok,
    ).toBe(true);
  });

  test("exhausts a turn budget on the turn that reaches it", () => {
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    for (let turn = 1; turn <= 40; turn += 1) {
      state = apply(state, 3 + turn, { type: "turn_completed" });
    }
    expect(state.attempt?.turns).toBe(40);
    expect(exhaustedConstraints(state)).toEqual([
      { constraint: "turns", scope: "building", consumed: 40, allowed: 40 },
    ]);

    // `continue` resets both watchdogs, so the attempt is inside its budget again and the reducer would refuse a
    // repeat of the very claim it just accepted.
    state = apply(state, 44, { type: "attention_required", kind: "constraint_exhausted", reason: "40 turns" });
    state = apply(state, 45, { type: "attention_cleared", resolution: "continue" });
    expect(exhaustedConstraints(state)).toEqual([]);
    expect(state.attempt).toMatchObject({ turns: 40, turnsGranted: 40 });
  });

  test("a targeted rerun clears only the record its target names", () => {
    // Both `constraint_exhausted` and `uncertain_gate` permit `rerun`, and a resolution otherwise clears every
    // record permitting it. Granting an ein attempt is no answer to a gate whose outcome is unknown (ADR 0043).
    let state = throughExhaustedWallClock();
    state = apply(state, 5, {
      type: "attention_required",
      kind: "uncertain_gate",
      reason: "the local validation run may or may not have completed",
    });

    state = apply(state, 6, { type: "attention_cleared", resolution: "rerun", target: "building" });
    expect(state.attention.map((record) => record.kind)).toEqual(["uncertain_gate"]);
    expect(state.stage).toBe("needs_attention");
    // The grant landed in the scope the target named, and the suspended attempt was abandoned for it.
    expect(state.ledgers.building).toEqual({ attemptsConsumed: 1, attemptsGranted: 1 });
    expect(state.attempt).toBeNull();

    // The remaining reason takes the target that addresses it, and grants no attempt at all.
    state = apply(state, 7, { type: "attention_cleared", resolution: "rerun", target: "validation" });
    expect(state.attention).toEqual([]);
    expect(state.stage).toBe("implementing");
    expect(state.ledgers.building).toEqual({ attemptsConsumed: 1, attemptsGranted: 1 });
  });

  test("refuses a rerun whose target names a reason nobody raised", () => {
    let state = initial();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "attention_required", kind: "uncertain_gate", reason: "unclear CI result" });

    expect(
      applyWorkflowEvent(state, message(3, { type: "attention_cleared", resolution: "rerun", target: "review" })),
    ).toMatchObject({ ok: false, error: { type: "attention_kind_not_raised", kind: "constraint_exhausted" } });
  });

  test("spends a validated-candidate slot where CI passes, and only there", () => {
    let state = throughPushedCandidate();
    expect(state.validatedCandidatesConsumed).toBe(0);
    state = apply(state, 5, ciPassed);
    // A CI-passed candidate is what a validated candidate *is*, so this is the branch that charges the spec's
    // allowance (`.scratch/bebop-mvp/issues/09-default-constraints-and-exhaustion.md`).
    expect(state.validatedCandidatesConsumed).toBe(1);
    expect(state.stage).toBe("code_review");
  });

  test("resets building attempts at a build-cycle boundary but not at a CI failure", () => {
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    state = apply(state, 4, { type: "attempt_ended", outcome: "completed" });
    state = apply(state, 5, { type: "candidate_submitted", candidate });
    state = apply(state, 6, {
      type: "gate_completed",
      gate: "local_validation",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    state = apply(state, 7, { type: "stage_changed", stage: "pushed_candidate" });
    state = apply(state, 8, {
      type: "gate_completed",
      gate: "pr_ci",
      candidateSha,
      specRevision: 1,
      outcome: "failed",
      feedback: { kind: "external_ci", checks: [{ name: "build", outcome: "failed" }] },
    });
    // CI feedback returns to ein inside the same build cycle, so the attempt it already spent still counts.
    // Resetting here would hand ein an unlimited supply by way of candidates that fail.
    expect(state.stage).toBe("revision");
    expect(state.ledgers.building.attemptsConsumed).toBe(1);

    // A blocking review result is a valid completion that starts a new cycle, and that does reset it.
    let reviewed = throughPushedCandidate();
    reviewed = apply(reviewed, 5, ciPassed);
    reviewed = apply(reviewed, 6, { type: "cowboy_activated", seat: "jet", seatId: "seat-jet-1" });
    reviewed = apply(reviewed, 7, { type: "attempt_started" });
    reviewed = apply(reviewed, 8, { type: "attempt_ended", outcome: "completed" });
    reviewed = apply(reviewed, 9, {
      type: "gate_completed",
      gate: "code_review",
      candidateSha,
      specRevision: 1,
      outcome: "failed",
      feedback: {
        kind: "review",
        findings: [
          {
            id: "finding-1",
            severity: "blocking",
            title: "The privileged path is unguarded.",
            description: "The candidate writes outside the worktree without an approval.",
            evidence: "src/write.ts:12",
          },
        ],
      },
    });
    expect(reviewed.ledgers.building.attemptsConsumed).toBe(0);
    expect(reviewed.ledgers.review.attemptsConsumed).toBe(1);
  });

  test("a new candidate resets the two per-candidate ledgers and a new spec resets everything", () => {
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    state = apply(state, 4, { type: "attempt_ended", outcome: "completed" });
    state = apply(state, 5, { type: "candidate_submitted", candidate });
    expect(state.ledgers).toMatchObject({
      building: { attemptsConsumed: 1 },
      review: { attemptsConsumed: 0 },
      qa: { attemptsConsumed: 0 },
    });

    // Confirming a new spec revision is the only thing that creates a fresh validated-candidate allowance, and
    // it creates fresh scoped ledgers with it.
    state = apply(state, 6, { type: "control_changed", controller: "human", reason: "takeover" });
    state = apply(state, 7, { type: "effective_spec_set", spec: { ...spec, revision: 2 } });
    expect(state.ledgers.building.attemptsConsumed).toBe(0);
    expect(state.validatedCandidatesConsumed).toBe(0);
  });

  test("reports validated candidates as exhausted only once another SHA is what is needed", () => {
    // Three validated candidates with the third still under review is a healthy bounty. The same three with a
    // rejecting result in hand is one that cannot legally produce a fourth without `reopen-spec`.
    const spent: TestState = { ...initial(), validatedCandidatesConsumed: 3, stage: "code_review" };
    expect(exhaustedConstraints(spent)).toEqual([]);
    expect(exhaustedConstraints({ ...spent, stage: "revision" })).toEqual([
      { constraint: "validated_candidates", scope: null, consumed: 3, allowed: 3 },
    ]);
  });

  test("refuses another candidate after the spec allowance is spent", () => {
    const specified = apply(initial(), 1, { type: "effective_spec_set", spec });
    const spent: TestState = {
      ...specified,
      stage: "revision",
      validatedCandidatesConsumed: 3,
    };

    expect(applyWorkflowEvent(spent, message(2, { type: "candidate_submitted", candidate }))).toMatchObject({
      ok: false,
      error: { type: "validated_candidates_exhausted", consumed: 3, allowed: 3 },
    });
  });

  test("a new spec clears obsolete constraint attention but preserves unrelated reasons", () => {
    const specified = apply(initial(), 1, { type: "effective_spec_set", spec });
    let state: TestState = {
      ...specified,
      stage: "revision",
      controller: "human",
      validatedCandidatesConsumed: 3,
    };
    state = apply(state, 2, {
      type: "attention_required",
      kind: "constraint_exhausted",
      reason: "the spec has used all 3 validated candidates",
    });
    state = apply(state, 3, { type: "attention_required", kind: "environment", reason: "the VM is unreachable" });

    state = apply(state, 4, { type: "effective_spec_set", spec: { ...spec, revision: 2 } });

    expect(state.validatedCandidatesConsumed).toBe(0);
    expect(state.attention.map((record) => record.kind)).toEqual(["environment"]);
    expect(state.stage).toBe("needs_attention");
    expect(state.suspendedStage).toBe("implementing");
  });

  test("stands the attempt down with the cowboy when the workflow ends", () => {
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    state = apply(state, 4, { type: "stage_changed", stage: "cancelling" });
    state = apply(state, 5, { type: "stage_changed", stage: "cancelled" });
    expect(state.attempt).toBeNull();
    expect(state.activeCowboy).toBeNull();
  });

  test("refuses to retire a seat that still has an attempt in flight", () => {
    // An attempt is one cowboy assignment, so a seat standing down under a running attempt would leave the
    // attempt accruing against nobody.
    let state = readyToBuild();
    state = apply(state, 3, { type: "attempt_started" });
    expect(
      applyWorkflowEvent(state, message(4, { type: "cowboy_deactivated", seat: "ein", seatId: "seat-ein" })),
    ).toMatchObject({ ok: false, error: { type: "attempt_already_active", scope: "building", ordinal: 1 } });
  });
});
