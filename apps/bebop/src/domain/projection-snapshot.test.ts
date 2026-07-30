// The projection snapshot must survive a round trip through `jsonb`.
//
// This is what makes "restarting the API and worker preserves projections" true. If a
// snapshot cannot be decoded back, a restart quietly starts every bounty's projection over —
// and because the workflow reducer rejects a sequence gap, the next event from a running
// Swordfish would then be refused forever.

import type { SwordfishEvent } from "@bebop/contracts";
import { BountyId, EventMessage, Timestamp, VmId } from "@bebop/contracts";
import { ConnectionId } from "@bebop/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  decodeWorkflowSnapshot,
  encodeWorkflowSnapshot,
  fromWorkflowSnapshot,
  toWorkflowSnapshot,
} from "#src/domain/projection-snapshot.ts";
import type { BebopSwordfishProjection } from "#src/domain/swordfish-projection.ts";
import {
  makeInitialBebopSwordfishProjection,
  reduceBebopSwordfishProjection,
} from "#src/domain/swordfish-projection.ts";

const bountyId = Schema.decodeUnknownSync(BountyId)("bty-01jz8j3d9f4x");
const vmId = Schema.decodeUnknownSync(VmId)("vm-bty-01jz8j3d9f4x");
const connectionId = Schema.decodeUnknownSync(ConnectionId)("conn-01");
const observedAt = Schema.decodeUnknownSync(Timestamp)("2026-07-29T12:00:00.000Z");
const occurredAt = "2026-07-29T12:00:00.000Z";
const candidateSha = "b".repeat(40);

function eventMessage(sequence: number, event: typeof SwordfishEvent.Encoded) {
  return Schema.decodeUnknownSync(EventMessage)({
    type: "event",
    protocolVersion: 1,
    bountyId,
    vmId,
    sequence,
    occurredAt,
    event,
  });
}

function apply(state: BebopSwordfishProjection, sequence: number, event: typeof SwordfishEvent.Encoded) {
  const outcome = reduceBebopSwordfishProjection(state, {
    type: "event_received",
    connectionId,
    message: eventMessage(sequence, event),
    observedAt,
  });
  if (!outcome.ok) {
    throw new Error(`the projection rejected the event: ${outcome.error.type}`);
  }
  return outcome.state;
}

/** A projection with something in every field a snapshot has to carry. */
function populatedProjection(): BebopSwordfishProjection {
  const registered = reduceBebopSwordfishProjection(makeInitialBebopSwordfishProjection(bountyId, vmId), {
    type: "connection_registered",
    connectionId,
    observedAt,
  });
  if (!registered.ok) {
    throw new Error("registration failed");
  }
  let state = apply(registered.state, 1, {
    type: "effective_spec_set",
    spec: {
      revision: 1,
      title: "Add a health endpoint",
      goal: "Expose liveness without a credential.",
      context: ["The API runs behind Caddy."],
      constraints: ["No new dependencies."],
      nonGoals: ["Readiness checks."],
      acceptanceCriteria: [{ id: "ac-1", description: "GET /api/health returns 200." }],
      suggestedQaScenarios: [{ description: "Hit the route", expectedOutcome: "200 ok" }],
      createdFromSeatId: "seat-ein",
      createdAt: occurredAt,
    },
  });
  state = apply(state, 2, {
    type: "lease_changed",
    seat: "ein",
    seatId: "seat-ein",
    owner: "swordfish",
  });
  state = apply(state, 3, {
    type: "attachments_updated",
    previews: [{ label: "app", url: "https://preview.invalid/", port: 3000 }],
  });
  state = apply(state, 4, {
    type: "candidate_submitted",
    candidate: {
      commitSha: candidateSha,
      specRevision: 1,
      summary: "Added the route.",
      claimedLocalChecks: [{ command: "bun test", result: "passed" }],
      activeDevelopmentServers: [{ name: "api", port: 3000 }],
      knownLimitations: ["No readiness check."],
      disposition: "candidate_ready",
    },
  });
  state = apply(state, 5, {
    type: "gate_completed",
    gate: "local_validation",
    candidateSha,
    specRevision: 1,
    outcome: "passed",
  });
  return state;
}

describe("workflow snapshot", () => {
  test("round-trips every field through the encoding Postgres stores", () => {
    const before = populatedProjection();
    // `JSON.parse(JSON.stringify(...))` is what a `jsonb` column does to a document: values
    // survive, the JavaScript identity does not.
    const stored: unknown = JSON.parse(JSON.stringify(encodeWorkflowSnapshot(toWorkflowSnapshot(before))));
    const after = fromWorkflowSnapshot(decodeWorkflowSnapshot(stored));

    expect(after.lastAppliedSequence).toBe(before.lastAppliedSequence);
    expect(after.stage).toBe(before.stage);
    expect(after.effectiveSpec?.title).toBe("Add a health endpoint");
    expect(after.effectiveSpec?.acceptanceCriteria).toHaveLength(1);
    expect(after.candidate?.commitSha).toBe(candidateSha);
    expect(after.gates.local_validation.status).toBe("passed");
    expect(after.leases.ein?.owner).toBe("swordfish");
    expect(after.previews).toHaveLength(1);
    expect(after.appliedEventFingerprints).toEqual(before.appliedEventFingerprints);
    expect(after.fingerprintFloor).toBe(before.fingerprintFloor);
  });

  test("a restored projection accepts the next event rather than reporting a gap", () => {
    // The property that actually matters: a restarted Bebop must be able to keep applying the
    // stream a still-running Swordfish is sending.
    const before = populatedProjection();
    const stored: unknown = JSON.parse(JSON.stringify(encodeWorkflowSnapshot(toWorkflowSnapshot(before))));
    const restored: BebopSwordfishProjection = {
      ...fromWorkflowSnapshot(decodeWorkflowSnapshot(stored)),
      bountyId,
      vmId,
      lastProducedSequence: before.lastProducedSequence,
      connectionId,
      stage: before.stage,
      freshness: { status: "connected", lastObservedAt: observedAt },
    };

    const next = reduceBebopSwordfishProjection(restored, {
      type: "event_received",
      connectionId,
      message: eventMessage(6, { type: "stage_changed", stage: "pushed_candidate" }),
      observedAt,
    });
    expect(next.ok).toBe(true);
    expect(next.ok && next.applied && next.state.stage).toBe("pushed_candidate");
  });

  test("a restored projection still recognises a replay of an event it already applied", () => {
    const before = populatedProjection();
    const stored: unknown = JSON.parse(JSON.stringify(encodeWorkflowSnapshot(toWorkflowSnapshot(before))));
    const restored: BebopSwordfishProjection = {
      ...fromWorkflowSnapshot(decodeWorkflowSnapshot(stored)),
      bountyId,
      vmId,
      lastProducedSequence: before.lastProducedSequence,
      connectionId,
      stage: before.stage,
      freshness: { status: "connected", lastObservedAt: observedAt },
    };

    // Fingerprints have to survive the round trip for this to be `already_applied` rather
    // than an error — that is what makes the restarted gateway safe to acknowledge on.
    const replay = reduceBebopSwordfishProjection(restored, {
      type: "event_received",
      connectionId,
      message: eventMessage(2, { type: "lease_changed", seat: "ein", seatId: "seat-ein", owner: "swordfish" }),
      observedAt,
    });
    expect(replay.ok && !replay.applied && replay.reason).toBe("already_applied");
  });
});
