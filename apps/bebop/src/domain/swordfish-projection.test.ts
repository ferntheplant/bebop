import type { SwordfishEvent } from "@bebop/contracts";
import { BountyId, ConnectionId, EventMessage, HeartbeatMessage, Timestamp, VmId } from "@bebop/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  makeInitialBebopSwordfishProjection,
  reduceBebopSwordfishProjection,
  unreportedBudgetOverrun,
  type BebopSwordfishProjection,
} from "#src/domain/swordfish-projection.ts";

const timestamp = "2026-07-26T12:34:56.000Z";
const candidateSha = "b".repeat(40);
const bountyId = Schema.decodeUnknownSync(BountyId)("bty-01jz8j3d9f4x");
const vmId = Schema.decodeUnknownSync(VmId)("vm_01JZ8J3D9F4X");
const connectionId = Schema.decodeUnknownSync(ConnectionId)("conn-01");
const replacementConnectionId = Schema.decodeUnknownSync(ConnectionId)("conn-02");
const observedAt = Schema.decodeUnknownSync(Timestamp)("2026-07-26T12:35:01.000Z");
const staleBefore = Schema.decodeUnknownSync(Timestamp)("2026-07-26T12:36:00.000Z");
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

function eventMessage(sequence: number, event: typeof SwordfishEvent.Encoded) {
  return Schema.decodeUnknownSync(EventMessage)({
    type: "event",
    protocolVersion: 1,
    bountyId,
    vmId,
    sequence,
    occurredAt: timestamp,
    event,
  });
}

function apply(state: BebopSwordfishProjection, sequence: number, event: typeof SwordfishEvent.Encoded) {
  const result = reduceBebopSwordfishProjection(state, {
    type: "event_received",
    connectionId,
    message: eventMessage(sequence, event),
    observedAt,
  });
  if (!result.ok) {
    throw new Error(`Projection rejected ${result.error.type}`);
  }
  return result.state;
}

function initialProjection(): BebopSwordfishProjection {
  const initial = makeInitialBebopSwordfishProjection(bountyId, vmId);
  const registered = reduceBebopSwordfishProjection(initial, {
    type: "connection_registered",
    connectionId,
    observedAt,
  });
  if (!registered.ok) {
    throw new Error(registered.error.type);
  }
  return registered.state;
}

describe("Bebop Swordfish projection reducer", () => {
  test("projects ordered events and treats readiness as a claim", () => {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "candidate_submitted", candidate });
    state = apply(state, 3, {
      type: "gate_completed",
      gate: "local_validation",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    state = apply(state, 4, { type: "stage_changed", stage: "pushed_candidate" });
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
    state = apply(state, 9, {
      type: "gate_completed",
      gate: "evidence_upload",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });

    expect(state.stage).toBe("ready");
    expect(state.readinessClaim).toEqual({ candidateSha, specRevision: 1 });
    expect("status" in state).toBe(false);

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

  test("deduplicates replay, rejects gaps, and clears invalidated authority", () => {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "candidate_submitted", candidate });
    const duplicate = reduceBebopSwordfishProjection(state, {
      type: "event_received",
      connectionId,
      message: eventMessage(2, { type: "candidate_submitted", candidate }),
      observedAt,
    });
    expect(duplicate).toEqual({ ok: true, applied: false, reason: "already_applied", state });
    const collision = reduceBebopSwordfishProjection(state, {
      type: "event_received",
      connectionId,
      message: eventMessage(2, { type: "attention_required", kind: "operational", reason: "conflict" }),
      observedAt,
    });
    expect(collision).toMatchObject({ ok: false, error: { type: "sequence_collision", sequence: 2 } });

    const gap = reduceBebopSwordfishProjection(state, {
      type: "event_received",
      connectionId,
      message: eventMessage(4, { type: "attention_required", kind: "operational", reason: "gap" }),
      observedAt,
    });
    expect(gap).toMatchObject({ ok: false, error: { type: "sequence_gap", expected: 3, received: 4 } });

    state = apply(state, 3, {
      type: "candidate_invalidated",
      candidateSha,
      specRevision: 1,
      reason: "branch_head_changed",
    });
    expect(state.candidate).toBeNull();
    expect(Object.values(state.gates).every((gate) => gate.status === "not_started")).toBe(true);
  });

  test("tracks connection freshness without rewriting workflow state", () => {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    const heartbeat = Schema.decodeUnknownSync(HeartbeatMessage)({
      type: "heartbeat",
      protocolVersion: 1,
      bountyId,
      vmId,
      sentAt: timestamp,
      lastProducedEventSequence: 4,
    });
    const connected = reduceBebopSwordfishProjection(state, {
      type: "heartbeat_observed",
      connectionId,
      message: heartbeat,
      observedAt,
    });
    if (!connected.ok) {
      throw new Error(connected.error.type);
    }
    expect(connected.state.stage).toBe("implementing");
    expect(connected.state.freshness.status).toBe("connected");

    const disconnected = reduceBebopSwordfishProjection(connected.state, {
      type: "connection_lost",
      connectionId,
      detectedAt: Schema.decodeUnknownSync(Timestamp)("2026-07-26T12:36:01.000Z"),
    });
    expect(disconnected).toMatchObject({
      ok: true,
      state: { stage: "implementing", freshness: { status: "disconnected" } },
    });
    if (!disconnected.ok) {
      throw new Error(disconnected.error.type);
    }
    const delayedHeartbeat = reduceBebopSwordfishProjection(disconnected.state, {
      type: "heartbeat_observed",
      connectionId,
      message: heartbeat,
      observedAt,
    });
    // `connection_lost` cleared `connectionId`, so a heartbeat still claiming that
    // connection can no longer match one. The gateway must not acknowledge this.
    expect(delayedHeartbeat).toEqual({
      ok: true,
      applied: false,
      reason: "wrong_connection",
      state: disconnected.state,
    });
  });

  test("ignores stale disconnects and marks the active connection stale", () => {
    const state = initialProjection();
    const replaced = reduceBebopSwordfishProjection(state, {
      type: "connection_registered",
      connectionId: replacementConnectionId,
      observedAt,
    });
    if (!replaced.ok) {
      throw new Error(replaced.error.type);
    }
    const oldDisconnect = reduceBebopSwordfishProjection(replaced.state, {
      type: "connection_lost",
      connectionId,
      detectedAt: observedAt,
    });
    expect(oldDisconnect).toEqual({ ok: true, applied: false, reason: "wrong_connection", state: replaced.state });

    const stale = reduceBebopSwordfishProjection(replaced.state, {
      type: "freshness_expired",
      connectionId: replacementConnectionId,
      staleBefore,
      detectedAt: observedAt,
    });
    expect(stale).toMatchObject({ ok: true, state: { freshness: { status: "stale" } } });
  });

  test("does not expire traffic observed after the sweep cutoff", () => {
    const state = initialProjection();
    const cutoffBeforeObservation = Schema.decodeUnknownSync(Timestamp)("2026-07-26T12:35:00.000Z");
    const result = reduceBebopSwordfishProjection(state, {
      type: "freshness_expired",
      connectionId,
      staleBefore: cutoffBeforeObservation,
      detectedAt: staleBefore,
    });
    expect(result).toEqual({ ok: true, applied: false, reason: "recently_observed", state });
  });

  test("a late heartbeat on the current connection recovers from stale", () => {
    // Without a recovery edge, a merely late heartbeat -- a GC pause, a slow link, a
    // tightly tuned staleness threshold -- froze Bebop's view of a live socket forever.
    const state = initialProjection();
    const stale = reduceBebopSwordfishProjection(state, {
      type: "freshness_expired",
      connectionId,
      staleBefore,
      detectedAt: observedAt,
    });
    if (!stale.ok) {
      throw new Error(stale.error.type);
    }
    expect(stale.state.freshness.status).toBe("stale");

    const laterObservedAt = Schema.decodeUnknownSync(Timestamp)("2026-07-26T12:40:00.000Z");
    const recovered = reduceBebopSwordfishProjection(stale.state, {
      type: "heartbeat_observed",
      connectionId,
      message: Schema.decodeUnknownSync(HeartbeatMessage)({
        type: "heartbeat",
        protocolVersion: 1,
        bountyId,
        vmId,
        sentAt: timestamp,
        lastProducedEventSequence: 1,
      }),
      observedAt: laterObservedAt,
    });
    expect(recovered).toMatchObject({
      ok: true,
      applied: true,
      state: { freshness: { status: "connected", lastObservedAt: laterObservedAt } },
    });
  });

  test("an event on a stale current connection is applied, not discarded", () => {
    const state = initialProjection();
    const stale = reduceBebopSwordfishProjection(state, {
      type: "freshness_expired",
      connectionId,
      staleBefore,
      detectedAt: observedAt,
    });
    if (!stale.ok) {
      throw new Error(stale.error.type);
    }

    const result = reduceBebopSwordfishProjection(stale.state, {
      type: "event_received",
      connectionId,
      message: eventMessage(1, { type: "effective_spec_set", spec }),
      observedAt,
    });
    // Traffic is traffic: an arriving event proves the socket is alive just as a heartbeat
    // does, and the event itself must not be silently dropped.
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      state: { stage: "implementing", freshness: { status: "connected" } },
    });
  });

  test("freshness still refreshes when the event itself is a duplicate", () => {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    const stale = reduceBebopSwordfishProjection(state, {
      type: "freshness_expired",
      connectionId,
      staleBefore,
      detectedAt: observedAt,
    });
    if (!stale.ok) {
      throw new Error(stale.error.type);
    }

    const duplicate = reduceBebopSwordfishProjection(stale.state, {
      type: "event_received",
      connectionId,
      message: eventMessage(1, { type: "effective_spec_set", spec }),
      observedAt,
    });
    expect(duplicate).toMatchObject({
      ok: true,
      applied: false,
      reason: "already_applied",
      state: { freshness: { status: "connected" } },
    });
  });

  test("rejects pushing a candidate before local validation passes", () => {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "candidate_submitted", candidate });
    const result = reduceBebopSwordfishProjection(state, {
      type: "event_received",
      connectionId,
      message: eventMessage(3, { type: "stage_changed", stage: "pushed_candidate" }),
      observedAt,
    });
    expect(result).toMatchObject({ ok: false, error: { type: "illegal_transition" } });
  });

  test("preserves human control while invalidating the suspended workflow", () => {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "candidate_submitted", candidate });
    state = apply(state, 3, {
      type: "gate_completed",
      gate: "local_validation",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    state = apply(state, 4, { type: "stage_changed", stage: "pushed_candidate" });
    state = apply(state, 5, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    state = apply(state, 6, { type: "control_changed", controller: "human", reason: "takeover" });
    state = apply(state, 7, {
      type: "candidate_invalidated",
      candidateSha,
      specRevision: 1,
      reason: "new_commit",
    });
    // Bebop's projection reaches the same conclusion as Swordfish: the work moved, control did not.
    expect(state.stage).toBe("revision");
    expect(state.suspendedStage).toBeNull();
    expect(state.controller).toBe("human");
  });

  test("resumes the underlying projected stage after repeated attention events", () => {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "attention_required", kind: "operational", reason: "Inspect the repository." });
    expect(state).toMatchObject({ stage: "needs_attention", suspendedStage: "implementing" });
    state = apply(state, 3, { type: "attention_required", kind: "operational", reason: "Still blocked." });
    expect(state).toMatchObject({ stage: "needs_attention", suspendedStage: "implementing" });
    expect(state.attention).toMatchObject([{ reason: "Still blocked." }]);
    state = apply(state, 4, { type: "attention_cleared", resolution: "resume" });
    expect(state).toMatchObject({ stage: "implementing", suspendedStage: null, attention: [] });
  });

  test("projects attention during human control without releasing control", () => {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "candidate_submitted", candidate });
    state = apply(state, 3, {
      type: "gate_completed",
      gate: "local_validation",
      candidateSha,
      specRevision: 1,
      outcome: "passed",
    });
    state = apply(state, 4, { type: "stage_changed", stage: "pushed_candidate" });
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
  });
});

describe("daemon budget cross-check", () => {
  const graceMs = 60_000;
  const iso = (minutes: number) => new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
  const at = (minutes: number) => Schema.decodeUnknownSync(Timestamp)(iso(minutes));

  /** A projection with one ein attempt running, which is the only shape the wall-clock check has anything to say about. */
  function withRunningAttempt(): BebopSwordfishProjection {
    let state = initialProjection();
    state = apply(state, 1, { type: "effective_spec_set", spec });
    state = apply(state, 2, { type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    return apply(state, 3, { type: "attempt_started" });
  }

  test("says nothing about an attempt that is still inside its budget", () => {
    expect(unreportedBudgetOverrun(withRunningAttempt(), at(80), graceMs)).toEqual([]);
  });

  test("discounts the grace margin before calling a budget overrun a defect", () => {
    // At 90 minutes and 30 seconds the daemon is barely past its watchdog and Bebop's own view is a heartbeat
    // behind it. Reporting there would turn ordinary projection lag into a defect signal.
    const state = withRunningAttempt();
    expect(unreportedBudgetOverrun(state, at(90.5), graceMs)).toEqual([]);
    expect(unreportedBudgetOverrun(state, at(92), graceMs)).toEqual([
      { constraint: "wall_clock", scope: "building", consumed: 91 * 60_000, allowed: 90 * 60_000 },
    ]);
  });

  test("says nothing once the daemon has reported the exhaustion itself", () => {
    // This is the whole distinction: a daemon that raised the attention is working, and only a daemon that is
    // long past budget and silent is the defect ("Constraint exhaustion is computed, not announced" (ADR 0042)).
    // The claim has to be one the projection's own arithmetic supports, so the event lands 91 minutes in.
    const running = withRunningAttempt();
    const raised = reduceBebopSwordfishProjection(running, {
      type: "event_received",
      connectionId,
      message: Schema.decodeUnknownSync(EventMessage)({
        type: "event",
        protocolVersion: 1,
        bountyId,
        vmId,
        sequence: 4,
        occurredAt: iso(91),
        event: {
          type: "attention_required",
          kind: "constraint_exhausted",
          reason: "the ein attempt ran out of wall clock",
        },
      }),
      observedAt,
    });
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    expect(unreportedBudgetOverrun(raised.state, at(200), graceMs)).toEqual([]);
  });

  test("says nothing while a human is driving, however long they take", () => {
    // Human-controlled work is unconstrained, and the clock stopped at the takeover, so the hours that follow
    // are not an overrun anybody failed to report.
    let state = withRunningAttempt();
    state = apply(state, 4, { type: "control_changed", controller: "human", reason: "takeover" });
    expect(unreportedBudgetOverrun(state, at(600), graceMs)).toEqual([]);
  });
});
