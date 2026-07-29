// The HTTP API against a real disposable Postgres (PLAN Milestone 3 exit criterion 1).

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Harness } from "#test/component/support/harness.ts";
import { sampleCreateRequest, startHarness, testDatabaseAvailable } from "#test/component/support/harness.ts";

const suite = testDatabaseAvailable ? describe : describe.skip;

suite("Bebop API over Postgres", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness("api");
  });

  afterAll(async () => {
    await harness.close();
  });

  const create = (idempotencyKey: string, body: Record<string, unknown> = { ...sampleCreateRequest }) =>
    harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });

  test("serves liveness without a credential", async () => {
    const response = await harness.request("/api/health", { anonymous: true });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ok");
  });

  test("refuses an unauthenticated request to a bounty route", async () => {
    const response = await harness.request("/api/bounties", { anonymous: true });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("unauthorized");
  });

  test("refuses an unknown bearer token", async () => {
    const response = await harness.request("/api/bounties", {
      anonymous: true,
      headers: { authorization: "Bearer bebop_not-a-real-token" },
    });
    expect(response.status).toBe(401);
  });

  // The middleware wraps the endpoint effect and must return it. A version that validated the
  // credential and returned something else would pass every test above while answering every
  // authorised request with nothing (`spikes/effect-runtime`, finding 1).
  test("lets an authorised request reach its handler", async () => {
    const response = await harness.request("/api/bounties");
    expect(response.status).toBe(200);
    expect((await response.json()) as { bounties: ReadonlyArray<unknown> }).toHaveProperty("bounties");
  });

  test("creates a bounty and assigns it a bounty/* branch", async () => {
    const response = await create("create-1");
    expect(response.status).toBe(201);
    const bounty = (await response.json()) as { bountyId: string; assignedBranch: string; status: string };
    expect(bounty.assignedBranch).toBe(`bounty/${bounty.bountyId}`);
    expect(bounty.status).toBe("provisioning");
  });

  test("replays one idempotency key instead of creating a second bounty", async () => {
    const first = (await (await create("idem-1")).json()) as { bountyId: string };
    const second = (await (await create("idem-1")).json()) as { bountyId: string };
    expect(second.bountyId).toBe(first.bountyId);

    const listed = (await (await harness.request("/api/bounties")).json()) as {
      bounties: ReadonlyArray<{ bountyId: string }>;
    };
    expect(listed.bounties.filter((entry) => entry.bountyId === first.bountyId)).toHaveLength(1);
  });

  test("refuses a reused idempotency key carrying a different request", async () => {
    await create("idem-2");
    const response = await create("idem-2", { ...sampleCreateRequest, baseRef: "develop" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("conflict");
  });

  test("reports an unknown bounty as not found", async () => {
    const response = await harness.request("/api/bounties/bty-does-not-exist");
    expect(response.status).toBe(404);
  });

  test("rejects a create with no idempotency key at the boundary", async () => {
    const response = await harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleCreateRequest),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  test("rejects a payload that violates the contract before any handler runs", async () => {
    const response = await create("bad-1", { ...sampleCreateRequest, computeProfile: "enormous" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
