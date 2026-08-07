import { SfStatusSnapshot } from "@bebop/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { describeDuration, renderStatusReport } from "#src/status-report.ts";

const observedAt = "2026-07-26T12:34:56.000Z";
const baseSnapshot = {
  stateRevision: 0,
  observedAt,
  bountyId: "bty-01jz8j3d9f4x",
  vmId: "vm_01JZ8J3D9F4X",
  repository: "withco/bebop",
  assignedBranch: "bounty/bty-01jz8j3d9f4x",
  stage: "implementing",
  controller: "swordfish",
  seats: [],
  attention: [],
  constraints: [],
  validatedCandidates: { consumed: 0, base: 3, granted: 0 },
  exhausted: [],
  previews: [],
  recentEvents: [],
  gates: [],
} as const;

function bebopLine(bebopConnection: Record<string, unknown>): string {
  const snapshot = Schema.decodeUnknownSync(SfStatusSnapshot)({ ...baseSnapshot, bebopConnection });
  const line = renderStatusReport(snapshot)
    .split("\n")
    .find((candidate) => candidate.startsWith("bebop "));
  if (line === undefined) throw new Error("the status report printed no bebop line");
  return line;
}

const delivery = { acknowledgedThrough: 7, pendingEventCount: 2 };

describe("sf status reports the Bebop connection", () => {
  test("a connected daemon says so and nothing more", () => {
    expect(bebopLine({ state: "connected", connectedAt: "2026-07-26T12:00:00.000Z", ...delivery })).toBe(
      "bebop       connected",
    );
  });

  test("a disconnected daemon says how long, and when it tries again", () => {
    // Both halves matter: the duration is what tells a long outage from a blip, and the next
    // attempt is what tells retrying-with-backoff from stuck.
    expect(
      bebopLine({
        state: "disconnected",
        disconnectedSince: "2026-07-26T12:04:56.000Z",
        nextAttemptAt: "2026-07-26T12:35:26.000Z",
        lastContactAt: "2026-07-26T12:04:56.000Z",
        ...delivery,
      }),
    ).toBe("bebop       disconnected 30m ago, retry in 30s");
  });

  test("a daemon that has never reached Bebop is not reported as having lost it", () => {
    expect(bebopLine({ state: "never_connected", neverConnectedSince: "2026-07-26T12:32:56.000Z", ...delivery })).toBe(
      "bebop       never connected (2m trying)",
    );
  });

  test("the three states are distinguishable from each other", () => {
    const rendered = [
      bebopLine({ state: "connected", connectedAt: observedAt, ...delivery }),
      bebopLine({
        state: "disconnected",
        disconnectedSince: observedAt,
        nextAttemptAt: observedAt,
        ...delivery,
      }),
      bebopLine({ state: "never_connected", neverConnectedSince: observedAt, ...delivery }),
    ];
    expect(new Set(rendered).size).toBe(3);
  });

  test("a next attempt already due reads as zero rather than as negative time", () => {
    expect(
      bebopLine({
        state: "disconnected",
        disconnectedSince: "2026-07-26T12:34:00.000Z",
        nextAttemptAt: "2026-07-26T12:34:50.000Z",
        ...delivery,
      }),
    ).toBe("bebop       disconnected 56s ago, retry in 0s");
  });
});

describe("durations", () => {
  test("names the coarsest scale that still says something", () => {
    expect(describeDuration(0)).toBe("0s");
    expect(describeDuration(999)).toBe("0s");
    expect(describeDuration(45_000)).toBe("45s");
    expect(describeDuration(120_000)).toBe("2m");
    expect(describeDuration(150_000)).toBe("2m 30s");
    expect(describeDuration(3_600_000)).toBe("1h");
    expect(describeDuration(5_400_000)).toBe("1h 30m");
  });

  test("clamps a negative span at zero", () => {
    expect(describeDuration(-5_000)).toBe("0s");
  });
});
