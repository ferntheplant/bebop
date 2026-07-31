// Bounty lifecycle across the API and the worker, and what survives a restart.
//
// Milestone 3 exit criteria: "creating the same bounty request with one idempotency key
// cannot create duplicate lifecycle work" and "restarting the API and worker preserves
// bounties, commands, tokens, and projections".

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Harness } from "#test/component/support/harness.ts";
import { sampleCreateRequest, startHarness, testDatabaseAvailable } from "#test/component/support/harness.ts";

const suite = testDatabaseAvailable ? describe : describe.skip;

interface BountyBody {
  readonly bountyId: string;
  readonly status: string;
  readonly attachment?: { readonly ssh?: { readonly host: string }; readonly previews: ReadonlyArray<unknown> };
}

function gatewayRefuses(url: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    let settled = false;
    const finish = (refused: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.close();
        resolve(refused);
      }
    };
    const timer = setTimeout(() => finish(false), 3_000);
    socket.addEventListener("open", () => finish(false), { once: true });
    socket.addEventListener("error", () => finish(true), { once: true });
    socket.addEventListener("close", () => finish(true), { once: true });
  });
}

suite("Bounty lifecycle", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness("lifecycle");
  });

  afterAll(async () => {
    await harness.close();
  });

  const create = async (key: string): Promise<BountyBody> => {
    const response = await harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(sampleCreateRequest),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as BountyBody;
  };

  const get = async (bountyId: string): Promise<BountyBody> =>
    (await (await harness.request(`/api/bounties/${bountyId}`)).json()) as BountyBody;

  test("the worker provisions a created bounty and records its attachment", async () => {
    const created = await create("lifecycle-1");
    expect(created.status).toBe("provisioning");
    expect(created.attachment).toBeUndefined();

    await harness.runJobs();

    const provisioned = await get(created.bountyId);
    // Still `provisioning` to a client: `docs/design/SYSTEM.md` §10.1 does not consider a bounty created
    // until its Swordfish connects, and none has.
    expect(provisioned.status).toBe("provisioning");
    expect(provisioned.attachment?.ssh?.host).toBe("127.0.0.1");
    expect(provisioned.attachment?.previews).toHaveLength(1);

    const attachments = await harness.request(`/api/bounties/${created.bountyId}/attachments`);
    expect(attachments.status).toBe(200);
  });

  test("one idempotency key produces exactly one provisioning job", async () => {
    const first = await create("lifecycle-2");
    // The second request must not enqueue a second provision even though it goes through the
    // whole create path again.
    const replayed = await harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "lifecycle-2" },
      body: JSON.stringify(sampleCreateRequest),
    });
    expect(((await replayed.json()) as BountyBody).bountyId).toBe(first.bountyId);

    await harness.runJobs();
    const provisionsRecorded = harness.provisioned.filter((record) => record.vmId === `vm-${first.bountyId}`);
    expect(provisionsRecorded).toHaveLength(1);
  });

  test("reclaims a lifecycle job after its worker exits", async () => {
    const created = await create("lifecycle-abandoned");
    expect(await harness.abandonNextJob()).not.toBeNull();

    // The deterministic clock advances past the harness's short lease before this worker
    // claims. A running row that was not a lease would remain invisible forever.
    await harness.runJobs();

    const recovered = await get(created.bountyId);
    expect(recovered.attachment?.ssh?.host).toBe("127.0.0.1");
    expect(harness.provisioned.filter((entry) => entry.vmId === `vm-${created.bountyId}`)).toHaveLength(1);
  });

  test("concurrent creates sharing a key create one bounty", async () => {
    const send = () =>
      harness.request("/api/bounties", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "lifecycle-race" },
        body: JSON.stringify(sampleCreateRequest),
      });
    const responses = await Promise.all([send(), send(), send(), send()]);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as ReadonlyArray<BountyBody>;
    const ids = new Set(bodies.map((body) => body.bountyId));
    expect(ids.size).toBe(1);
    const bountyId = bodies[0]?.bountyId;
    expect(bountyId).toBeDefined();
    await harness.runJobs();
    expect(harness.provisioned.filter((record) => record.vmId === `vm-${bountyId}`)).toHaveLength(1);
  });

  test("stopping queues a command and moves the bounty to stopped", async () => {
    const bounty = await create("lifecycle-3");
    await harness.runJobs();

    const stopped = await harness.request(`/api/bounties/${bounty.bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Not needed after all." }),
    });
    expect(stopped.status).toBe(202);
    expect(((await stopped.json()) as BountyBody).status).toBe("stopped");
    const repeated = await harness.request(`/api/bounties/${bounty.bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Repeated request." }),
    });
    expect(repeated.status).toBe(202);
    expect(await harness.commandCountForBounty(bounty.bountyId)).toBe(1);
  });

  test("a late provisioning result cannot resurrect a stopped bounty", async () => {
    const bounty = await create("lifecycle-stop-during-provision");
    const stopped = await harness.request(`/api/bounties/${bounty.bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Stop before the worker claims provision." }),
    });
    expect(((await stopped.json()) as BountyBody).status).toBe("stopped");

    await harness.runJobs();
    const afterProvision = await get(bounty.bountyId);
    expect(afterProvision.status).toBe("stopped");
    expect(afterProvision.attachment?.ssh?.host).toBe("127.0.0.1");
  });

  test("repeating one config approval does not queue duplicate commands", async () => {
    const bounty = await create("lifecycle-approval");
    const candidateSha = "a".repeat(40);
    const approve = () =>
      harness.request(`/api/bounties/${bounty.bountyId}/approve-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateSha }),
      });
    expect((await approve()).status).toBe(202);
    expect((await approve()).status).toBe(202);
    expect(await harness.commandCountForBounty(bounty.bountyId)).toBe(1);
  });

  test("destroying deprovisions through the worker and drops the attachment", async () => {
    const bounty = await create("lifecycle-4");
    await harness.runJobs();
    const credential = harness.provisioned.find((record) => record.vmId === `vm-${bounty.bountyId}`)?.swordfishToken;
    expect(credential).toBeDefined();

    const destroyed = await harness.request(`/api/bounties/${bounty.bountyId}`, { method: "DELETE" });
    expect(destroyed.status).toBeLessThan(300);
    await harness.runJobs();

    const after = await get(bounty.bountyId);
    expect(after.status).toBe("stopped");
    expect(after.attachment).toBeUndefined();
    expect((await harness.request(`/api/bounties/${bounty.bountyId}/attachments`)).status).toBe(404);
    expect(await gatewayRefuses(harness.gatewayUrl, credential ?? "")).toBe(true);
  });

  test("destroy requested during provisioning finishes destroyed", async () => {
    const bounty = await create("lifecycle-destroy-during-provision");
    expect((await harness.request(`/api/bounties/${bounty.bountyId}`, { method: "DELETE" })).status).toBeLessThan(300);
    await harness.runJobs();

    const destroyed = await get(bounty.bountyId);
    expect(destroyed.status).toBe("stopped");
    expect(destroyed.attachment).toBeUndefined();
  });

  test("recovery re-arms one provisioning job with the same VM credential", async () => {
    const bounty = await create("lifecycle-recover");
    await harness.runJobs();
    const before = harness.provisioned.filter((record) => record.vmId === `vm-${bounty.bountyId}`);
    expect(before).toHaveLength(1);

    const first = await harness.request(`/api/bounties/${bounty.bountyId}/recover`, { method: "POST" });
    const second = await harness.request(`/api/bounties/${bounty.bountyId}/recover`, { method: "POST" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await harness.runJobs();

    const attempts = harness.provisioned.filter((record) => record.vmId === `vm-${bounty.bountyId}`);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.swordfishToken).toBe(attempts[0]?.swordfishToken);
    expect((await get(bounty.bountyId)).attachment?.ssh?.host).toBe("127.0.0.1");
  });

  test("refuses to merge without the GitHub authority that would make it real", async () => {
    const bounty = await create("lifecycle-5");
    const response = await harness.request(`/api/bounties/${bounty.bountyId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedHeadSha: "a".repeat(40) }),
    });
    expect(response.status).toBe(422);
  });

  test("restarting the API preserves bounties, tokens, and commands", async () => {
    const bounty = await create("lifecycle-6");
    await harness.runJobs();
    await harness.request(`/api/bounties/${bounty.bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    await harness.restart();

    // The same token still authenticates, which is only true because it was stored rather
    // than held in the process that just went away.
    const after = await get(bounty.bountyId);
    expect(after.bountyId).toBe(bounty.bountyId);
    expect(after.status).toBe("stopped");
    expect(after.attachment?.ssh?.host).toBe("127.0.0.1");

    const listed = (await (await harness.request("/api/bounties")).json()) as {
      bounties: ReadonlyArray<BountyBody>;
    };
    expect(listed.bounties.some((entry) => entry.bountyId === bounty.bountyId)).toBe(true);
  });

  test("retries an uncertain provision with the same credential", async () => {
    const failing = await startHarness("lifecycle-after-effect", { failProvisionAfterEffectAttempts: 1 });
    try {
      const response = await failing.request("/api/bounties", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "after-effect" },
        body: JSON.stringify(sampleCreateRequest),
      });
      const created = (await response.json()) as BountyBody;
      await failing.runJobs();

      expect(failing.provisionAttempts).toBe(2);
      const attempts = failing.provisioned.filter((record) => record.vmId === `vm-${created.bountyId}`);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.swordfishToken).toBe(attempts[0]?.swordfishToken);
      const status = (await (await failing.request(`/api/bounties/${created.bountyId}`)).json()) as BountyBody;
      expect(status.attachment?.ssh?.host).toBe("127.0.0.1");
    } finally {
      await failing.close();
    }
  });

  test("parks exhausted provisioning and surfaces a failed bounty", async () => {
    const failing = await startHarness("lifecycle-exhausted", { failProvisionAttempts: 5 });
    try {
      const response = await failing.request("/api/bounties", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "exhausted" },
        body: JSON.stringify(sampleCreateRequest),
      });
      const created = (await response.json()) as BountyBody;
      await failing.runJobs();

      expect(failing.provisionAttempts).toBe(5);
      expect(failing.provisioned).toHaveLength(0);
      const status = (await (await failing.request(`/api/bounties/${created.bountyId}`)).json()) as BountyBody;
      expect(status.status).toBe("failed");
    } finally {
      await failing.close();
    }
  });

  test("parks exhausted destruction without hiding the live attachment", async () => {
    const failing = await startHarness("lifecycle-destroy-exhausted", { failDestroyAttempts: 5 });
    try {
      const response = await failing.request("/api/bounties", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "destroy-exhausted" },
        body: JSON.stringify(sampleCreateRequest),
      });
      const created = (await response.json()) as BountyBody;
      await failing.runJobs();
      await failing.request(`/api/bounties/${created.bountyId}`, { method: "DELETE" });
      await failing.runJobs();

      const status = (await (await failing.request(`/api/bounties/${created.bountyId}`)).json()) as BountyBody;
      expect(status.status).toBe("failed");
      expect(status.attachment?.ssh?.host).toBe("127.0.0.1");
    } finally {
      await failing.close();
    }
  });
});
