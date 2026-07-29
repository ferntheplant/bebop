// The Swordfish connection gateway over a real WebSocket (SPEC section 18).

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Harness } from "#test/component/support/harness.ts";
import { sampleCreateRequest, startHarness, testDatabaseAvailable } from "#test/component/support/harness.ts";
import { readSseFrames } from "#test/component/support/sse.ts";

const suite = testDatabaseAvailable ? describe : describe.skip;

interface Peer {
  readonly send: (message: unknown) => void;
  /** Waits for the next message of the given type, or rejects on the deadline. */
  readonly next: <T = Record<string, unknown>>(type: string, timeoutMs?: number) => Promise<T>;
  readonly received: ReadonlyArray<Record<string, unknown>>;
  readonly close: () => void;
}

/** A minimal Swordfish: enough protocol to exercise the gateway, none of the workflow. */
async function connect(harness: Harness, token: string): Promise<Peer> {
  const socket = new WebSocket(harness.gatewayUrl, { headers: { authorization: `Bearer ${token}` } });
  const received: Array<Record<string, unknown>> = [];
  const waiters: Array<{ type: string; resolve: (value: Record<string, unknown>) => void }> = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    received.push(message);
    const index = waiters.findIndex((waiter) => waiter.type === message["type"]);
    if (index !== -1) {
      waiters.splice(index, 1)[0]?.resolve(message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("the gateway refused the connection")));
    socket.addEventListener("close", (event) => reject(new Error(`the gateway closed the connection (${event.code})`)));
  });

  return {
    send: (message) => socket.send(JSON.stringify(message)),
    next: <T = Record<string, unknown>>(type: string, timeoutMs = 5_000) => {
      const already = received.find((message) => message["type"] === type);
      if (already !== undefined) {
        return Promise.resolve(already as T);
      }
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} message within ${timeoutMs}ms`)), timeoutMs);
        waiters.push({
          type,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value as T);
          },
        });
      });
    },
    received,
    close: () => socket.close(),
  };
}

const at = (millis: number) => new Date(Date.UTC(2026, 6, 29, 12, 0, 0, 0) + millis).toISOString();

suite("Swordfish gateway", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness("gateway");
  });

  afterAll(async () => {
    await harness.close();
  });

  /** Creates a bounty, provisions it, and returns its identity plus its Swordfish credential. */
  const provisionedBounty = async (key: string) => {
    const created = await harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(sampleCreateRequest),
    });
    const bountyId = ((await created.json()) as { bountyId: string }).bountyId;
    await harness.runJobs();
    const record = harness.provisioned.find((entry) => entry.vmId === `vm-${bountyId}`);
    if (record === undefined) {
      throw new Error("the bounty was not provisioned");
    }
    return { bountyId, vmId: record.vmId, token: record.swordfishToken };
  };

  const register = (peer: Peer, bounty: { bountyId: string; vmId: string }) =>
    peer.send({
      type: "register",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      swordfishVersion: "0.0.0-test",
      lastProducedEventSequence: 0,
    });

  test("refuses an upgrade with no credential", async () => {
    const response = await harness.request("/swordfish", {
      anonymous: true,
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    expect(response.status).toBe(401);
  });

  test("refuses an upgrade with an unknown credential", async () => {
    let refused = false;
    try {
      await connect(harness, "bebop_sf_not-a-real-token");
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test("registers, acknowledges an event, and updates the projection", async () => {
    const bounty = await provisionedBounty("gateway-1");
    const peer = await connect(harness, bounty.token);

    register(peer, bounty);
    const registered = await peer.next<{ acknowledgedThrough: number; connectionId: string }>("registered");
    expect(registered.acknowledgedThrough).toBe(0);
    expect(registered.connectionId).toBeTruthy();

    peer.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 1,
      occurredAt: at(0),
      event: { type: "stage_changed", stage: "interactive" },
    });
    const acknowledged = await peer.next<{ acknowledgedThrough: number }>("event_acknowledged");
    expect(acknowledged.acknowledgedThrough).toBe(1);

    const bountyBody = (await (await harness.request(`/api/bounties/${bounty.bountyId}`)).json()) as {
      status: string;
      swordfishStage: string;
      swordfishFreshness: string;
    };
    expect(bountyBody.swordfishStage).toBe("interactive");
    expect(bountyBody.status).toBe("interactive");
    expect(bountyBody.swordfishFreshness).toBe("connected");

    peer.close();
  });

  test("acknowledges a replayed event without applying it twice", async () => {
    const bounty = await provisionedBounty("gateway-2");
    const peer = await connect(harness, bounty.token);
    register(peer, bounty);
    await peer.next("registered");

    const event = {
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 1,
      occurredAt: at(0),
      event: { type: "stage_changed", stage: "interactive" },
    };
    peer.send(event);
    await peer.next("event_acknowledged");
    peer.send(event);
    // Two acknowledgements for one event: at-least-once delivery means Swordfish may resend,
    // and refusing to acknowledge a duplicate would loop replay forever.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const acknowledgements = peer.received.filter((message) => message["type"] === "event_acknowledged");
    expect(acknowledgements.length).toBe(2);

    // One projected event on the client stream, not two.
    const frames = await readSseFrames(harness, `/api/bounties/${bounty.bountyId}/events`, { count: 3 });
    expect(frames.filter((frame) => frame.type === "swordfish_event")).toHaveLength(1);

    peer.close();
  });

  test("rejects an event that skips a sequence", async () => {
    const bounty = await provisionedBounty("gateway-3");
    const peer = await connect(harness, bounty.token);
    register(peer, bounty);
    await peer.next("registered");

    peer.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 4,
      occurredAt: at(0),
      event: { type: "stage_changed", stage: "interactive" },
    });
    const error = await peer.next<{ code: string }>("protocol_error");
    expect(error.code).toBe("sequence_gap");
    peer.close();
  });

  test("rejects a message that names a different bounty", async () => {
    const bounty = await provisionedBounty("gateway-4");
    const other = await provisionedBounty("gateway-5");
    const peer = await connect(harness, bounty.token);
    register(peer, bounty);
    await peer.next("registered");

    peer.send({
      type: "heartbeat",
      protocolVersion: 1,
      bountyId: other.bountyId,
      vmId: other.vmId,
      sentAt: at(0),
      lastProducedEventSequence: 0,
    });
    const error = await peer.next<{ code: string }>("protocol_error");
    expect(error.code).toBe("identity_mismatch");
    peer.close();
  });

  test("rejects an unsupported protocol version", async () => {
    const bounty = await provisionedBounty("gateway-6");
    const peer = await connect(harness, bounty.token);
    peer.send({
      type: "register",
      protocolVersion: 99,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      swordfishVersion: "0.0.0-test",
      lastProducedEventSequence: 0,
    });
    const error = await peer.next<{ code: string }>("protocol_error");
    expect(error.code).toBe("unsupported_version");
    peer.close();
  });

  test("delivers a command queued before the connection existed", async () => {
    const bounty = await provisionedBounty("gateway-7");
    // Queued while nothing is connected — SPEC section 18.4's offline case.
    await harness.request(`/api/bounties/${bounty.bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Stop this one." }),
    });

    const peer = await connect(harness, bounty.token);
    register(peer, bounty);
    await peer.next("registered");
    const command = await peer.next<{ commandId: string; command: { type: string } }>("command");
    expect(command.command.type).toBe("stop");

    peer.send({
      type: "command_result",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      commandId: command.commandId,
      status: "completed",
      reportedAt: at(0),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Reconnecting must not redeliver a command already handed over.
    peer.close();
    const second = await connect(harness, bounty.token);
    register(second, bounty);
    await second.next("registered");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(second.received.filter((message) => message["type"] === "command")).toHaveLength(0);
    second.close();
  });

  test("ignores a replaced connection rather than letting it write", async () => {
    const bounty = await provisionedBounty("gateway-9");
    const first = await connect(harness, bounty.token);
    register(first, bounty);
    await first.next("registered");

    // A second Swordfish registers — a reconnect whose predecessor has not noticed it is
    // gone. The projection now belongs to the second connection.
    const second = await connect(harness, bounty.token);
    register(second, bounty);
    await second.next("registered");

    // The stale connection sends an event. It must neither be applied nor acknowledged:
    // acknowledging an input Bebop discarded makes Swordfish drop it from its outbox
    // permanently, and it is then lost for good.
    first.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 1,
      occurredAt: at(0),
      event: { type: "stage_changed", stage: "interactive" },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(first.received.filter((message) => message["type"] === "event_acknowledged")).toHaveLength(0);

    const projected = (await (await harness.request(`/api/bounties/${bounty.bountyId}`)).json()) as {
      swordfishStage: string | undefined;
    };
    expect(projected.swordfishStage).toBeUndefined();

    // The live connection is unaffected and still writes normally.
    second.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 1,
      occurredAt: at(0),
      event: { type: "stage_changed", stage: "interactive" },
    });
    const acknowledged = await second.next<{ acknowledgedThrough: number }>("event_acknowledged");
    expect(acknowledged.acknowledgedThrough).toBe(1);

    first.close();
    second.close();
  });

  test("marks a connection stale when heartbeats stop, and disconnected across a restart", async () => {
    const bounty = await provisionedBounty("gateway-8");
    const peer = await connect(harness, bounty.token);
    register(peer, bounty);
    await peer.next("registered");

    // `swordfishStaleAfter` is 500ms in the harness configuration.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await harness.sweep()).toBeGreaterThanOrEqual(1);

    const stale = (await (await harness.request(`/api/bounties/${bounty.bountyId}`)).json()) as {
      swordfishFreshness: string;
    };
    expect(stale.swordfishFreshness).toBe("stale");

    peer.close();
    await harness.restart();

    // A restarted API has no sockets. Reporting the connection as anything but gone would
    // break SPEC section 9.3's rule outright.
    const afterRestart = (await (await harness.request(`/api/bounties/${bounty.bountyId}`)).json()) as {
      swordfishFreshness: string;
    };
    expect(afterRestart.swordfishFreshness).toBe("disconnected");
  }, 15_000);
});
