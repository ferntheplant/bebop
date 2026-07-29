// Bounty lifecycle across the API and the worker, and what survives a restart.
//
// PLAN Milestone 3 exit criteria: "creating the same bounty request with one idempotency key
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
    // Still `provisioning` to a client: SPEC section 10.1 does not consider a bounty created
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
  });

  test("destroying deprovisions through the worker and drops the attachment", async () => {
    const bounty = await create("lifecycle-4");
    await harness.runJobs();

    const destroyed = await harness.request(`/api/bounties/${bounty.bountyId}`, { method: "DELETE" });
    expect(destroyed.status).toBeLessThan(300);
    await harness.runJobs();

    const after = await get(bounty.bountyId);
    expect(after.status).toBe("stopped");
    expect(after.attachment).toBeUndefined();
    expect((await harness.request(`/api/bounties/${bounty.bountyId}/attachments`)).status).toBe(404);
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
});
