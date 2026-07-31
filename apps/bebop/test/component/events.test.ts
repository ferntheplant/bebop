// Cursor replay followed by live delivery (Milestone 3 exit criterion 3).

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Harness } from "#test/component/support/harness.ts";
import { sampleCreateRequest, startHarness, testDatabaseAvailable } from "#test/component/support/harness.ts";
import { readSseFrames } from "#test/component/support/sse.ts";

const suite = testDatabaseAvailable ? describe : describe.skip;

suite("Bounty event stream", () => {
  let harness: Harness;
  let bountyId: string;

  beforeAll(async () => {
    harness = await startHarness("events");
    const created = await harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "events-1" },
      body: JSON.stringify(sampleCreateRequest),
    });
    bountyId = ((await created.json()) as { bountyId: string }).bountyId;
    // A handful of stored events to replay: provisioning, then the worker's transitions.
    await harness.runJobs();
    await harness.request(`/api/bounties/${bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  test("replays every stored event once, in order, with the id equal to the cursor", async () => {
    const frames = await readSseFrames(harness, `/api/bounties/${bountyId}/events`, { count: 2 });
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.map((frame) => frame.cursor)).toEqual([1, 2]);
    expect(frames.every((frame) => frame.id === String(frame.cursor))).toBe(true);
    expect(frames[0]?.type).toBe("bounty_status_changed");
  });

  test("resumes from Last-Event-ID without a gap or a duplicate", async () => {
    const all = await readSseFrames(harness, `/api/bounties/${bountyId}/events`, { count: 2 });
    const resumed = await readSseFrames(harness, `/api/bounties/${bountyId}/events`, {
      count: 1,
      lastEventId: String(all[0]?.cursor),
    });
    expect(resumed[0]?.cursor).toBe(2);
    expect(resumed.some((frame) => frame.cursor <= 1)).toBe(false);
  });

  test("delivers an event produced after the client attached", async () => {
    // The subscriber attaches first and the event is produced while it is listening, so this
    // fails if live delivery only ever reads what already existed at subscription time.
    const stored = await readSseFrames(harness, `/api/bounties/${bountyId}/events`, { count: 2 });
    const cursorBefore = stored.at(-1)?.cursor ?? 0;

    const live = readSseFrames(harness, `/api/bounties/${bountyId}/events`, {
      count: 1,
      lastEventId: String(cursorBefore),
      timeoutMs: 8_000,
    });

    // Give the subscription a moment to get past replay before producing anything.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await harness.request(`/api/bounties/${bountyId}`, { method: "GET" });
    await harness.request(`/api/bounties/${bountyId}/recover`, { method: "POST" });

    const frames = await live;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]?.cursor).toBe(cursorBefore + 1);
  });

  test("streams across a replay page and into a concurrently appended event", async () => {
    const created = await harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "events-paged" },
      body: JSON.stringify(sampleCreateRequest),
    });
    const pagedBountyId = ((await created.json()) as { bountyId: string }).bountyId;
    // Creation is cursor 1. Add enough history to cross the server's 200-row page boundary.
    await harness.appendTestEvents(pagedBountyId, 204);
    const replayAndLive = readSseFrames(harness, `/api/bounties/${pagedBountyId}/events`, {
      count: 206,
      timeoutMs: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.appendTestEvents(pagedBountyId, 1);

    const frames = await replayAndLive;
    expect(frames.map((frame) => frame.cursor)).toEqual(Array.from({ length: 206 }, (_, index) => index + 1));
    expect(new Set(frames.map((frame) => frame.cursor)).size).toBe(206);
  });

  test("refuses to stream an unknown bounty", async () => {
    const response = await harness.request("/api/bounties/bty-nope/events");
    expect(response.status).toBe(404);
  });

  test("refuses to stream without a credential", async () => {
    const response = await harness.request(`/api/bounties/${bountyId}/events`, { anonymous: true });
    expect(response.status).toBe(401);
  });
});
