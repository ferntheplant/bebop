import { Timestamp } from "@bebop/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  afterConnectionLoss,
  encodeBebopConnection,
  initialBackoff,
  nextBackoff,
  type BebopConnectionLiveState,
} from "#src/domain/connection-state.ts";

const at = (iso: string) => Schema.decodeUnknownSync(Timestamp)(iso);
const started = at("2026-07-26T12:00:00.000Z");
const lost = at("2026-07-26T12:30:00.000Z");
const later = at("2026-07-26T12:31:00.000Z");
const evenLater = at("2026-07-26T12:33:00.000Z");

describe("the live Bebop connection", () => {
  test("a failed attempt before the first registration stays never-connected since start", () => {
    const before: BebopConnectionLiveState = { kind: "never_connected", since: started };
    expect(afterConnectionLoss(before, lost, later)).toEqual(before);
  });

  test("losing an established connection dates the outage from the loss", () => {
    const after = afterConnectionLoss({ kind: "connected", connectedAt: started }, lost, later);
    expect(after).toEqual({ kind: "disconnected", disconnectedSince: lost, nextAttemptAt: later });
  });

  test("a retry during an outage moves the next attempt without restarting the clock", () => {
    // The regression this guards: dating the outage from the latest failed retry made a
    // half-hour outage report itself as however long the last attempt took.
    const first = afterConnectionLoss({ kind: "connected", connectedAt: started }, lost, later);
    const second = afterConnectionLoss(first, later, evenLater);
    expect(second).toEqual({ kind: "disconnected", disconnectedSince: lost, nextAttemptAt: evenLater });
  });

  test("encodes each state with only the timestamps that state can honestly carry", () => {
    const delivery = { acknowledgedThrough: 4, pendingEventCount: 2 };
    const contact = "2026-07-26T12:29:00.000Z";
    expect(
      encodeBebopConnection({
        connection: { kind: "connected", connectedAt: started },
        lastContactAt: contact,
        ...delivery,
      }),
    ).toEqual({ state: "connected", connectedAt: "2026-07-26T12:00:00.000Z", lastContactAt: contact, ...delivery });
    expect(
      encodeBebopConnection({
        connection: { kind: "disconnected", disconnectedSince: lost, nextAttemptAt: later },
        lastContactAt: contact,
        ...delivery,
      }),
    ).toEqual({
      state: "disconnected",
      disconnectedSince: "2026-07-26T12:30:00.000Z",
      nextAttemptAt: "2026-07-26T12:31:00.000Z",
      lastContactAt: contact,
      ...delivery,
    });
    // A daemon that has never reached Bebop has no contact to report, whatever the column says.
    expect(
      encodeBebopConnection({
        connection: { kind: "never_connected", since: started },
        lastContactAt: contact,
        ...delivery,
      }),
    ).toEqual({ state: "never_connected", neverConnectedSince: "2026-07-26T12:00:00.000Z", ...delivery });
  });
});

describe("reconnect backoff", () => {
  test("doubles the ceiling toward the maximum and stops there", () => {
    let backoff = initialBackoff(100, 800);
    const ceilings: Array<number> = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      backoff = nextBackoff(backoff, 0).backoff;
      ceilings.push(backoff.ceilingMillis);
    }
    expect(ceilings).toEqual([200, 400, 800, 800, 800, 800]);
  });

  test("draws every wait within the configured bounds", () => {
    let backoff = initialBackoff(100, 800);
    for (const jitter of [0, 0.25, 0.5, 0.75, 0.999]) {
      const attempt = nextBackoff(backoff, jitter);
      backoff = attempt.backoff;
      expect(attempt.waitMillis).toBeGreaterThanOrEqual(100);
      expect(attempt.waitMillis).toBeLessThanOrEqual(800);
    }
  });

  test("spreads waits across the range rather than retrying in lockstep", () => {
    // Full jitter: the floor is the minimum and the top of the range is the current ceiling, so
    // two daemons drawing different fractions after the same outage do not return together.
    const backoff = { minimumMillis: 100, maximumMillis: 800, ceilingMillis: 400 };
    expect(nextBackoff(backoff, 0).waitMillis).toBe(100);
    expect(nextBackoff(backoff, 0.5).waitMillis).toBe(450);
  });

  test("a misconfigured maximum below the minimum still waits the minimum", () => {
    expect(nextBackoff(initialBackoff(500, 100), 0.9).waitMillis).toBe(500);
  });
});
