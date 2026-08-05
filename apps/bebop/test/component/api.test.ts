// The HTTP API against a real disposable Postgres (`docs/capabilities/01-bounty-lifecycle.md`).

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
  // authorised request with nothing (`prototypes/effect-runtime`, finding 1).
  test("lets an authorised request reach its handler", async () => {
    const response = await harness.request("/api/bounties");
    expect(response.status).toBe(200);
    expect((await response.json()) as { bounties: ReadonlyArray<unknown> }).toHaveProperty("bounties");
  });

  test("creates, lists, authenticates, and immediately revokes a named token", async () => {
    expect((await harness.request("/api/tokens", { anonymous: true })).status).toBe(401);

    const created = await harness.request("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "component-client" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: { tokenId: string; name: string }; secret: string };
    expect(body.token.name).toBe("component-client");
    expect(body.secret).toMatch(/^bebop_/);
    const storedHash = await harness.storedApiTokenHash("component-client");
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedHash).not.toBe(body.secret);

    const authenticated = await harness.request("/api/tokens", {
      anonymous: true,
      headers: { authorization: `Bearer ${body.secret}` },
    });
    expect(authenticated.status).toBe(200);
    const listedText = await authenticated.text();
    expect(listedText).toContain("component-client");
    expect(listedText).not.toContain(body.secret);

    const revoked = await harness.request(`/api/tokens/${body.token.tokenId}`, { method: "DELETE" });
    expect(revoked.status).toBe(202);
    expect(
      (
        await harness.request("/api/tokens", {
          anonymous: true,
          headers: { authorization: `Bearer ${body.secret}` },
        })
      ).status,
    ).toBe(401);

    const duplicate = await harness.request("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "component-client" }),
    });
    expect(duplicate.status).toBe(422);
    expect(((await duplicate.json()) as { code: string }).code).toBe("unprocessable_entity");
  });

  test("creates a bounty and assigns it a bounty/* branch", async () => {
    const response = await create("create-1");
    expect(response.status).toBe(201);
    const bounty = (await response.json()) as { bountyId: string; assignedBranch: string; status: string };
    expect(bounty.assignedBranch).toBe(`bounty/${bounty.bountyId}`);
    expect(bounty.status).toBe("provisioning");
  });

  test("derives the operator credential for a provisioned bounty and refuses one without a VM", async () => {
    const created = await create("opcred-1");
    const bounty = (await created.json()) as { bountyId: string };

    // The credential dies with the VM (ADR 0038), so a bounty that has never been provisioned
    // has nothing to retrieve.
    const before = await harness.request(`/api/bounties/${bounty.bountyId}/operator-credential`, { method: "POST" });
    expect(before.status).toBe(404);

    await harness.runJobs();

    const retrieved = await harness.request(`/api/bounties/${bounty.bountyId}/operator-credential`, { method: "POST" });
    expect(retrieved.status).toBe(200);
    const body = (await retrieved.json()) as { operatorCredential: string };
    expect(body.operatorCredential).toMatch(/^bebop_op_/);

    // Derivation is deterministic and nothing is stored, so a second retrieval returns the
    // same credential rather than a minted one.
    const again = await harness.request(`/api/bounties/${bounty.bountyId}/operator-credential`, { method: "POST" });
    expect(((await again.json()) as { operatorCredential: string }).operatorCredential).toBe(body.operatorCredential);

    const unknown = await harness.request("/api/bounties/bty-does-not-exist/operator-credential", { method: "POST" });
    expect(unknown.status).toBe(404);
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
    const before = (await (await harness.request("/api/bounties")).json()) as {
      bounties: ReadonlyArray<unknown>;
    };
    const response = await harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleCreateRequest),
    });
    expect(response.status).toBe(400);
    const after = (await (await harness.request("/api/bounties")).json()) as {
      bounties: ReadonlyArray<unknown>;
    };
    expect(after.bounties).toHaveLength(before.bounties.length);
  });

  test("rejects a payload that violates the contract before any handler runs", async () => {
    const before = (await (await harness.request("/api/bounties")).json()) as {
      bounties: ReadonlyArray<unknown>;
    };
    const response = await create("bad-1", { ...sampleCreateRequest, computeProfile: "enormous" });
    expect(response.status).toBe(400);
    const after = (await (await harness.request("/api/bounties")).json()) as {
      bounties: ReadonlyArray<unknown>;
    };
    expect(after.bounties).toHaveLength(before.bounties.length);
  });
});
