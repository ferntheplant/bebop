// The Swordfish connection gateway over a real WebSocket (`docs/design/SYSTEM.md` §18).

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Harness } from "#test/component/support/harness.ts";
import { sampleCreateRequest, startHarness, testDatabaseAvailable } from "#test/component/support/harness.ts";
import { readSseFrames } from "#test/component/support/sse.ts";

const suite = testDatabaseAvailable ? describe : describe.skip;

interface Peer {
  readonly send: (message: unknown) => void;
  readonly sendRaw: (frame: string) => void;
  /** Waits for the next message of the given type, or rejects on the deadline. */
  readonly next: <T = Record<string, unknown>>(type: string, timeoutMs?: number) => Promise<T>;
  readonly received: ReadonlyArray<Record<string, unknown>>;
  readonly closed: Promise<number>;
  readonly close: () => void;
}

/** A minimal Swordfish: enough protocol to exercise the gateway, none of the workflow. */
async function connect(harness: Harness, token: string): Promise<Peer> {
  const socket = new WebSocket(harness.gatewayUrl, { headers: { authorization: `Bearer ${token}` } });
  const received: Array<Record<string, unknown>> = [];
  const waiters: Array<{ type: string; resolve: (value: Record<string, unknown>) => void }> = [];
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code), { once: true });
  });

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
    sendRaw: (frame) => socket.send(frame),
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
    closed,
    close: () => socket.close(),
  };
}

const at = (millis: number) => new Date(Date.UTC(2026, 6, 29, 12, 0, 0, 0) + millis).toISOString();

async function waitForMessageCount(peer: Peer, type: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (peer.received.filter((message) => message["type"] === type).length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`fewer than ${count} ${type} messages within 5000ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

  test("binds a bounty credential to the provisioned VM", async () => {
    const bounty = await provisionedBounty("gateway-vm-binding");
    const peer = await connect(harness, bounty.token);
    register(peer, { bountyId: bounty.bountyId, vmId: "vm-attacker" });
    const rejected = await peer.next<{ code: string }>("protocol_error");
    expect(rejected.code).toBe("identity_mismatch");

    // A rejected registration must not claim the session or poison the projection.
    register(peer, bounty);
    const registered = await peer.next<{ vmId: string }>("registered");
    expect(registered.vmId).toBe(bounty.vmId);
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

  test("processes consecutive event frames in protocol order", async () => {
    const bounty = await provisionedBounty("gateway-ordered");
    const peer = await connect(harness, bounty.token);
    register(peer, bounty);
    await peer.next("registered");

    // Do not wait for the first acknowledgement. The Bun socket adapter starts frame
    // handlers in separate fibers, so the gateway itself must serialize these operations.
    peer.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 1,
      occurredAt: at(0),
      event: { type: "stage_changed", stage: "interactive" },
    });
    peer.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 2,
      occurredAt: at(1),
      event: { type: "stage_changed", stage: "needs_attention", reason: "ordered" },
    });

    await waitForMessageCount(peer, "event_acknowledged", 2);
    expect(
      peer.received
        .filter((message) => message["type"] === "event_acknowledged")
        .map((message) => message["acknowledgedThrough"]),
    ).toEqual([1, 2]);
    expect(peer.received.filter((message) => message["type"] === "protocol_error")).toHaveLength(0);

    const projected = (await (await harness.request(`/api/bounties/${bounty.bountyId}`)).json()) as {
      swordfishStage: string;
    };
    expect(projected.swordfishStage).toBe("needs_attention");
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

  test("requires registration before stateful messages", async () => {
    const bounty = await provisionedBounty("gateway-register-first");
    const peer = await connect(harness, bounty.token);
    peer.send({
      type: "heartbeat",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sentAt: at(0),
      lastProducedEventSequence: 0,
    });
    expect((await peer.next<{ code: string }>("protocol_error")).code).toBe("invalid_message");
    peer.close();
  });

  test("fails closed on malformed and oversized frames", async () => {
    const malformedBounty = await provisionedBounty("gateway-malformed");
    const malformed = await connect(harness, malformedBounty.token);
    malformed.sendRaw("{");
    expect((await malformed.next<{ code: string }>("protocol_error")).code).toBe("invalid_message");

    const oversizedBounty = await provisionedBounty("gateway-oversized");
    const oversized = await connect(harness, oversizedBounty.token);
    oversized.sendRaw("x".repeat(262_145));
    expect((await oversized.next<{ code: string }>("protocol_error")).code).toBe("invalid_message");
    expect(await oversized.closed).toBe(1009);
    malformed.close();
  });

  test("rejects a conflicting replay at an applied sequence", async () => {
    const bounty = await provisionedBounty("gateway-conflicting-replay");
    const peer = await connect(harness, bounty.token);
    register(peer, bounty);
    await peer.next("registered");
    peer.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 1,
      occurredAt: at(0),
      event: { type: "stage_changed", stage: "interactive" },
    });
    await peer.next("event_acknowledged");
    peer.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 1,
      occurredAt: at(1),
      event: { type: "stage_changed", stage: "needs_attention", reason: "different" },
    });
    expect((await peer.next<{ code: string }>("protocol_error")).code).toBe("invalid_message");
    expect(peer.received.filter((message) => message["type"] === "event_acknowledged")).toHaveLength(1);
    peer.close();
  });

  test("delivers a command queued before the connection existed", async () => {
    const bounty = await provisionedBounty("gateway-7");
    // Queued while nothing is connected — `docs/design/SYSTEM.md` §18.4's offline case.
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

    // A delayed pre-terminal result must not regress a completed command to accepted.
    peer.send({
      type: "command_result",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      commandId: command.commandId,
      status: "accepted",
      reportedAt: at(1),
    });

    // Reconnecting must not redeliver a command already handed over.
    peer.close();
    const second = await connect(harness, bounty.token);
    register(second, bounty);
    await second.next("registered");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(second.received.filter((message) => message["type"] === "command")).toHaveLength(0);
    second.close();
  });

  test("rejects a command result from the wrong bounty", async () => {
    const firstBounty = await provisionedBounty("gateway-command-owner-a");
    const secondBounty = await provisionedBounty("gateway-command-owner-b");
    await harness.request(`/api/bounties/${secondBounty.bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const second = await connect(harness, secondBounty.token);
    register(second, secondBounty);
    await second.next("registered");
    const command = await second.next<{ commandId: string }>("command");

    const first = await connect(harness, firstBounty.token);
    register(first, firstBounty);
    await first.next("registered");
    first.send({
      type: "command_result",
      protocolVersion: 1,
      bountyId: firstBounty.bountyId,
      vmId: firstBounty.vmId,
      commandId: command.commandId,
      status: "completed",
      reportedAt: at(0),
    });
    const error = await first.next<{ code: string }>("protocol_error");
    expect(error.code).toBe("invalid_message");

    // The owner still receives the command because the foreign result changed nothing.
    second.close();
    const reconnected = await connect(harness, secondBounty.token);
    register(reconnected, secondBounty);
    await reconnected.next("registered");
    expect((await reconnected.next<{ commandId: string }>("command")).commandId).toBe(command.commandId);
    first.close();
    reconnected.close();
  });

  test("redelivers a command after an uncertain disconnect", async () => {
    const bounty = await provisionedBounty("gateway-command-replay");
    await harness.request(`/api/bounties/${bounty.bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const first = await connect(harness, bounty.token);
    register(first, bounty);
    await first.next("registered");
    const firstDelivery = await first.next<{ commandId: string }>("command");
    first.close();

    // No command_result was sent. A local WebSocket write is not evidence that Swordfish
    // durably stored the command, so reconnect must receive the same idempotency key.
    const second = await connect(harness, bounty.token);
    register(second, bounty);
    await second.next("registered");
    const replay = await second.next<{ commandId: string }>("command");
    expect(replay.commandId).toBe(firstDelivery.commandId);

    second.send({
      type: "command_result",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      commandId: replay.commandId,
      status: "accepted",
      reportedAt: at(0),
    });
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

  test("records an ordinary socket close as disconnected", async () => {
    const bounty = await provisionedBounty("gateway-disconnect");
    const peer = await connect(harness, bounty.token);
    register(peer, bounty);
    await peer.next("registered");
    peer.send({
      type: "event",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sequence: 1,
      occurredAt: at(0),
      event: { type: "stage_changed", stage: "interactive" },
    });
    await peer.next("event_acknowledged");
    peer.close();

    const deadline = Date.now() + 5_000;
    for (;;) {
      const body = (await (await harness.request(`/api/bounties/${bounty.bountyId}`)).json()) as {
        status: string;
        swordfishFreshness: string;
      };
      if (body.swordfishFreshness === "disconnected") {
        expect(body.status).toBe("needs_attention");
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("socket close was not projected as disconnected");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    const shutdownStartedAt = Date.now();
    await harness.restart();
    expect(Date.now() - shutdownStartedAt).toBeLessThan(2_000);

    // A restarted API has no sockets. Reporting the connection as anything but gone would
    // break `docs/design/SYSTEM.md` §9.3's rule outright.
    const afterRestart = (await (await harness.request(`/api/bounties/${bounty.bountyId}`)).json()) as {
      swordfishFreshness: string;
    };
    expect(afterRestart.swordfishFreshness).toBe("disconnected");
  }, 15_000);
});
