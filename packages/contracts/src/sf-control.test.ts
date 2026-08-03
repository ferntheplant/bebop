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
  activeCowboy: { role: "ein", seatId: "seat-ein" },
  seats: [{ role: "ein", seatId: "seat-ein" }],
  attention: [],
  constraints: [{ scope: "building", attempts: { consumed: 0, base: 3, granted: 0 } }],
  validatedCandidates: { consumed: 0, base: 3, granted: 0 },
  exhausted: [],
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
  { type: "continue" },
  { type: "rerun", target: "validation" },
  { type: "resume" },
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
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        activeCowboy: { role: "jet", seatId: "seat-jet-1" },
      }),
    ).toThrow();
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

  test("accepts repeated seat roles from retried attempts", () => {
    // Every jet and faye attempt takes a fresh seat ("One controller drives one active cowboy" (ADR 0037)), so
    // a second review attempt legitimately puts two `jet` rows in this list. Rejecting that made `sf status`
    // throw after an ordinary retry.
    const retried = Schema.decodeUnknownSync(SfStatusSnapshot)({
      ...baseSnapshot,
      activeCowboy: { role: "jet", seatId: "seat-jet-2" },
      seats: [
        { role: "ein", seatId: "seat-ein" },
        { role: "jet", seatId: "seat-jet-1" },
        { role: "jet", seatId: "seat-jet-2" },
      ],
    });
    expect(retried.seats).toHaveLength(3);
    expect(retried.activeCowboy?.seatId).toBe("seat-jet-2");

    // Seat IDs are still unique, and the active cowboy still has to be one of them.
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        seats: [
          { role: "jet", seatId: "seat-jet-1" },
          { role: "faye", seatId: "seat-jet-1" },
        ],
      }),
    ).toThrow();
  });

  test("rejects a stopped status with no stated reason", () => {
    // The cockpit prints the commands that restart a stopped bounty
    // (`docs/capabilities/05-control-lease-and-takeover.md`), so a `needs_attention` with nothing outstanding
    // would strand it with nothing to print.
    expect(() => Schema.decodeUnknownSync(SfStatusSnapshot)({ ...baseSnapshot, stage: "needs_attention" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        attention: [{ kind: "agent_blocked", reason: "needs a decision", resolutions: ["resume"] }],
      }),
    ).toThrow();

    const stopped = Schema.decodeUnknownSync(SfStatusSnapshot)({
      ...baseSnapshot,
      stage: "needs_attention",
      suspendedStage: "implementing",
      attention: [{ kind: "agent_blocked", reason: "needs a decision", resolutions: ["resume", "takeover"] }],
    });
    expect(stopped.attention[0]?.resolutions).toEqual(["resume", "takeover"]);
  });

  test("accepts attention retained through cancellation", () => {
    // A reason raised after a stop command is retained without reviving the run, so attention outlives
    // `needs_attention` on the cancellation path and status has to be able to say so.
    const cancelling = Schema.decodeUnknownSync(SfStatusSnapshot)({
      ...baseSnapshot,
      stage: "cancelling",
      attention: [{ kind: "environment", reason: "the VM is unreachable", resolutions: ["cancel"] }],
    });
    expect(cancelling.attention).toHaveLength(1);
  });

  test("rejects an exit the attention kind does not permit", () => {
    // An exhausted budget is revived by `continue` or `rerun`, never by a plain `resume`
    // ("Continue preserves an attempt; rerun replaces it" (ADR 0041)). A snapshot cannot offer otherwise.
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        stage: "needs_attention",
        attention: [{ kind: "constraint_exhausted", reason: "turn budget exhausted", resolutions: ["resume"] }],
      }),
    ).toThrow();
  });

  test("rejects two outstanding reasons of the same kind", () => {
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        stage: "needs_attention",
        attention: [
          { kind: "operational", reason: "first", resolutions: ["resume"] },
          { kind: "operational", reason: "second", resolutions: ["resume"] },
        ],
      }),
    ).toThrow();
  });

  test("binds the attempt in flight to the active cowboy", () => {
    // An attempt is one cowboy assignment, so an attempt naming a seat nobody is driving is a snapshot that has
    // lost track of one of the two ("One controller drives one active cowboy" (ADR 0037)).
    const attempt = {
      scope: "building",
      role: "ein",
      seatId: "seat-other",
      ordinal: 1,
      startedAt: timestamp,
      turns: { consumed: 4, base: 40, granted: 0 },
      wallClockMs: { consumed: 60_000, base: 5_400_000, granted: 0 },
      running: false,
    } as const;
    expect(() => Schema.decodeUnknownSync(SfStatusSnapshot)({ ...baseSnapshot, attempt })).toThrow();
    expect(
      Schema.decodeUnknownSync(SfStatusSnapshot)({ ...baseSnapshot, attempt: { ...attempt, seatId: "seat-ein" } })
        .attempt?.ordinal,
    ).toBe(1);
  });

  test("rejects a running clock while a human holds control", () => {
    // Taking over stops autonomous counting, so a snapshot that reports both is reporting a clock that should
    // not be turning ("Constraint exhaustion is computed, not announced" (ADR 0042)).
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        controller: "human",
        attempt: {
          scope: "building",
          role: "ein",
          seatId: "seat-ein",
          ordinal: 1,
          startedAt: timestamp,
          turns: { consumed: 4, base: 40, granted: 0 },
          wallClockMs: { consumed: 60_000, base: 5_400_000, granted: 0 },
          running: true,
        },
      }),
    ).toThrow();
  });

  test("rejects two ledger entries for one scope", () => {
    expect(() =>
      Schema.decodeUnknownSync(SfStatusSnapshot)({
        ...baseSnapshot,
        constraints: [
          { scope: "building", attempts: { consumed: 0, base: 3, granted: 0 } },
          { scope: "building", attempts: { consumed: 1, base: 3, granted: 0 } },
        ],
      }),
    ).toThrow();
  });
});
