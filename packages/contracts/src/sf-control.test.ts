import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import type { SfControlCommand } from "#src/sf-control.ts";
import { SfControlRequest, SfControlResponse, SfStatusSnapshot, sfControlErrorCodes } from "#src/sf-control.ts";

const timestamp = "2026-07-26T12:34:56.000Z";
const baseSnapshot = {
  stateRevision: 0,
  observedAt: timestamp,
  bountyId: "bty-01jz8j3d9f4x",
  vmId: "vm_01JZ8J3D9F4X",
  repository: "withco/bebop",
  assignedBranch: "bounty/bty-01jz8j3d9f4x",
  stage: "interactive",
  controller: "human",
  activeSeat: "ein",
  seats: [{ role: "ein", seatId: "seat-ein" }],
  constraints: [{ constraint: "primary_turns", consumed: 0, limit: 40, extensionsGranted: 0 }],
  bebopConnection: { state: "connected", lastContactAt: timestamp, acknowledgedThrough: 0, pendingEventCount: 0 },
  previews: [],
  recentEvents: [],
  gates: [],
} as const;

const commands: ReadonlyArray<typeof SfControlCommand.Encoded> = [
  { type: "status" },
  { type: "stop", reason: "User requested stop." },
  { type: "takeover", seat: "ein", force: false },
  { type: "handoff" },
  { type: "extend_constraint", constraint: "primary_turns" },
  { type: "retry_stage", stage: "local_validation" },
  { type: "approve_config" },
];

describe("sf local control contracts", () => {
  test.each(commands)("round-trips $type requests and successful snapshots", (command) => {
    const request = { type: "request", controlVersion: 1, correlationId: "corr-01", command } as const;
    const decodedRequest = Schema.decodeUnknownSync(SfControlRequest)(request);
    expect(Schema.encodeSync(SfControlRequest)(decodedRequest)).toEqual(request);

    const response = {
      type: "success",
      controlVersion: 1,
      correlationId: "corr-01",
      result: { command, snapshot: baseSnapshot },
    } as const;
    const decodedResponse = Schema.decodeUnknownSync(SfControlResponse)(response);
    expect(Schema.encodeSync(SfControlResponse)(decodedResponse)).toEqual(response);
  });

  test.each(sfControlErrorCodes)("round-trips %s errors", (code) => {
    const encoded = {
      type: "error",
      controlVersion: 1,
      correlationId: "corr-01",
      error: { code, message: "The command could not be applied." },
    } as const;
    const decoded = Schema.decodeUnknownSync(SfControlResponse)(encoded);
    expect(Schema.encodeSync(SfControlResponse)(decoded)).toEqual(encoded);
  });

  test("accepts candidate-bound gate and approval status", () => {
    const encoded = {
      ...baseSnapshot,
      stateRevision: 12,
      stage: "local_validation",
      activeSeat: "ein",
      effectiveSpecRevision: 1,
      candidateSha: "b".repeat(40),
      gates: [
        {
          gate: "local_validation",
          candidateSha: "b".repeat(40),
          specRevision: 1,
          status: "pending",
          attempts: 1,
          updatedAt: timestamp,
        },
      ],
      pendingConfigApproval: { candidateSha: "b".repeat(40), unifiedDiff: "diff --git a/.bebop/config.yml" },
    } as const;
    const decoded = Schema.decodeUnknownSync(SfStatusSnapshot)(encoded);
    expect(Schema.encodeSync(SfStatusSnapshot)(decoded)).toEqual(encoded);
  });

  test("rejects inconsistent status snapshots", () => {
    expect(() => Schema.decodeUnknownSync(SfStatusSnapshot)({ ...baseSnapshot, stage: "ready" })).toThrow();
    expect(() => Schema.decodeUnknownSync(SfStatusSnapshot)({ ...baseSnapshot, activeSeat: "jet" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        seats: [baseSnapshot.seats[0], baseSnapshot.seats[0]],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        candidateSha: "b".repeat(40),
        gates: [
          {
            gate: "qa",
            candidateSha: "c".repeat(40),
            specRevision: 1,
            status: "pending",
            attempts: 1,
            updatedAt: timestamp,
          },
        ],
      }),
    ).toThrow();
  });

  test("rejects a status that stops without exits, or offers exits without stopping", () => {
    // The cockpit prints attention detail whenever the stage says the bounty stopped
    // (`docs/capabilities/05-control-lease-and-takeover.md`). A snapshot carrying one without the other would
    // either strand a stopped bounty with nothing to print or advertise exits for work still running.
    expect(() => Schema.decodeUnknownSync(SfStatusSnapshot)({ ...baseSnapshot, stage: "needs_attention" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        attention: { kind: "agent_blocked", reason: "needs a decision", resolutions: ["resume"] },
      }),
    ).toThrow();

    const stopped = Schema.decodeUnknownSync(SfStatusSnapshot)({
      ...baseSnapshot,
      stage: "needs_attention",
      attention: {
        kind: "agent_blocked",
        reason: "needs a decision",
        suspendedStage: "implementing",
        resolutions: ["resume", "takeover"],
      },
    });
    expect(stopped.attention?.resolutions).toEqual(["resume", "takeover"]);
  });

  test("rejects an exit the attention kind does not permit", () => {
    // An exhausted budget is revived by `continue` or `rerun`, never by a plain `resume`
    // ("Continue preserves an attempt; rerun replaces it" (ADR 0041)). A snapshot cannot offer otherwise.
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        stage: "needs_attention",
        attention: {
          kind: "constraint_exhausted",
          reason: "primary turn budget exhausted",
          resolutions: ["resume"],
        },
      }),
    ).toThrow();
  });
});
