import type { RegisterMessage, SwordfishToBebopMessage } from "@bebop/contracts";
import {
  SwordfishEvent as SwordfishEventSchema,
  SwordfishToBebopMessage as SwordfishToBebopMessageSchema,
} from "@bebop/contracts";
import { Duration, Effect, Fiber, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { SwordfishConfiguration } from "#src/config.ts";
import { BebopConnectionState } from "#src/domain/connection-state.ts";
import { SwordfishStore } from "#src/persistence/store.ts";
import { runBebopClient } from "#src/protocol/client.ts";
import { WorkflowService, WorkflowTransitionError } from "#src/workflow/service.ts";
import type { SwordfishHarness } from "#test/component/support/harness.ts";
import { startSwordfishHarness } from "#test/component/support/harness.ts";

let harness: SwordfishHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${description}`);
}

interface FakePeer {
  port: number | undefined;
  /** Every frame Swordfish sent, decoded against the protocol contract. */
  readonly received: Array<SwordfishToBebopMessage>;
  /** Frames Swordfish sent that failed contract decoding; must always be empty. */
  readonly decodeErrors: Array<unknown>;
  /** The WebSocket subprotocol offered on each upgrade, proving the token reaches the peer. */
  readonly protocols: Array<string | null>;
  readonly state: { connections: number; registrations: number };
  stop: () => void;
}

type FakePeerSocket = Bun.ServerWebSocket<unknown>;

/**
 * A Bebop stand-in that contract-decodes every outbound frame. Tests branch on decoded
 * messages, so identity, cursor, and correlation fields are asserted by construction.
 */
function startFakePeer(handlers: {
  readonly onOpen?: (socket: FakePeerSocket, peer: FakePeer) => void;
  readonly onRegister?: (socket: FakePeerSocket, message: RegisterMessage, peer: FakePeer) => void;
  readonly onMessage?: (socket: FakePeerSocket, message: SwordfishToBebopMessage, peer: FakePeer) => void;
  readonly onClose?: (code: number, reason: string) => void;
}): FakePeer {
  const peer: FakePeer = {
    port: 0,
    received: [],
    decodeErrors: [],
    protocols: [],
    state: { connections: 0, registrations: 0 },
    stop: () => undefined,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      const protocol = request.headers.get("sec-websocket-protocol");
      peer.protocols.push(protocol);
      const upgraded = bunServer.upgrade(request, {
        headers: protocol === null ? undefined : { "sec-websocket-protocol": protocol },
      });
      return upgraded ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        peer.state.connections += 1;
        handlers.onOpen?.(socket, peer);
      },
      message(socket, data) {
        const raw = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as unknown;
        let message: SwordfishToBebopMessage;
        try {
          message = Schema.decodeUnknownSync(SwordfishToBebopMessageSchema)(raw);
        } catch (cause) {
          peer.decodeErrors.push(cause);
          return;
        }
        peer.received.push(message);
        if (message.type === "register") {
          peer.state.registrations += 1;
          handlers.onRegister?.(socket, message, peer);
        }
        handlers.onMessage?.(socket, message, peer);
      },
      close(_socket, code, reason) {
        handlers.onClose?.(code, reason);
      },
    },
  });
  peer.port = server.port;
  peer.stop = () => void server.stop(true);
  return peer;
}

function registeredMessage(registrations: number, acknowledgedThrough = 0): string {
  return JSON.stringify({
    type: "registered",
    protocolVersion: 1,
    connectionId: `conn-${registrations}`,
    bountyId: "bty-component",
    vmId: "vm-component",
    serverTime: "2026-07-29T00:00:00.000Z",
    acknowledgedThrough,
  });
}

describe("Swordfish outbound protocol", () => {
  test("keeps evaluating constraints while Bebop is unavailable", async () => {
    harness = await startSwordfishHarness("disconnected-constraint-watchdog");
    const realWorkflow = await harness.run(WorkflowService);
    let evaluations = 0;
    const fiber = harness.fork(
      runBebopClient.pipe(
        Effect.provideService(SwordfishConfiguration, {
          ...harness.config,
          heartbeatInterval: Duration.millis(10),
        }),
        Effect.provideService(WorkflowService, {
          ...realWorkflow,
          evaluateConstraints: Effect.sync(() => {
            evaluations += 1;
            return false;
          }),
        }),
      ),
    );
    try {
      await waitFor(() => evaluations >= 2, "constraint checks during disconnection");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("does not retry a reducer disagreement from the constraint watchdog", async () => {
    harness = await startSwordfishHarness("constraint-watchdog-transition");
    const realWorkflow = await harness.run(WorkflowService);
    const failure = new WorkflowTransitionError({
      error: { type: "exhaustion_unsupported", claim: "component test disagreement" },
    });
    const fiber = harness.fork(
      runBebopClient.pipe(
        Effect.provideService(WorkflowService, {
          ...realWorkflow,
          evaluateConstraints: Effect.fail(failure),
        }),
      ),
    );
    const exit = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeout("2 seconds")));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("WorkflowTransitionError");
      expect(String(exit.cause)).not.toContain("BebopSessionError");
    }
  });

  test.each([
    {
      label: "typed failures",
      marker: "heartbeat typed failure",
      failure: Effect.fail(
        new SqlError.SqlError({
          reason: new SqlError.UnknownError({
            cause: "heartbeat typed failure",
            message: "heartbeat typed failure",
          }),
        }),
      ),
    },
    {
      label: "defects",
      marker: "heartbeat defect",
      failure: Effect.die("heartbeat defect"),
    },
  ])("propagates heartbeat delivery $label to the client fiber", async ({ failure, marker }) => {
    const peer = startFakePeer({
      onRegister(socket, _message, { state }) {
        socket.send(registeredMessage(state.registrations));
      },
    });
    harness = await startSwordfishHarness(`heartbeat-${marker.replaceAll(" ", "-")}`, {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const realStore = await harness.run(SwordfishStore);
    let deliveryReads = 0;
    const fiber = harness.fork(
      runBebopClient.pipe(
        Effect.provideService(SwordfishStore, {
          ...realStore,
          deliveryState: Effect.suspend(() => {
            deliveryReads += 1;
            return deliveryReads === 1 ? realStore.deliveryState : failure;
          }),
        }),
      ),
    );
    try {
      const exit = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeout("2 seconds")));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain(marker);
      expect(deliveryReads).toBeGreaterThanOrEqual(2);
      expect(peer.state.connections).toBe(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  });

  test("drains preexisting events across every outbox page and persists the final acknowledgement", async () => {
    const eventCount = 130;
    const peer = startFakePeer({
      onRegister(socket, _message, { state }) {
        socket.send(registeredMessage(state.registrations));
      },
      onMessage(socket, message) {
        if (message.type === "event" && message.sequence === eventCount) {
          socket.send(
            JSON.stringify({
              type: "event_acknowledged",
              protocolVersion: 1,
              bountyId: "bty-component",
              vmId: "vm-component",
              acknowledgedThrough: message.sequence,
            }),
          );
        }
      },
    });
    harness = await startSwordfishHarness("multi-page-drain", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    await harness.run(
      Effect.gen(function* () {
        const workflow = yield* WorkflowService;
        for (let sequence = 2; sequence <= eventCount; sequence += 1) {
          yield* workflow.append(
            Schema.decodeUnknownSync(SwordfishEventSchema)({
              type: "attention_required",
              kind: "operational",
              reason: `preexisting event ${sequence}`,
            }),
          );
        }
      }),
    );
    const fiber = harness.fork(
      runBebopClient.pipe(
        Effect.provideService(SwordfishConfiguration, {
          ...harness.config,
          heartbeatInterval: Duration.seconds(10),
        }),
      ),
    );
    try {
      await waitFor(
        async () =>
          (await harness?.run(Effect.flatMap(SwordfishStore, (store) => store.deliveryState)))?.acknowledgedThrough ===
          eventCount,
        "the final multi-page acknowledgement",
      );

      const sequences = peer.received.filter((message) => message.type === "event").map((event) => event.sequence);
      expect(sequences).toEqual(Array.from({ length: eventCount }, (_, index) => index + 1));
      expect(
        (await harness.run(Effect.flatMap(SwordfishStore, (store) => store.deliveryState))).acknowledgedThrough,
      ).toBe(eventCount);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 20_000);

  test("registers, replays, reconnects, heartbeats, acknowledges, and deduplicates commands", async () => {
    let firstConnection: FakePeerSocket | undefined;
    const peer = startFakePeer({
      onOpen(socket) {
        if (firstConnection === undefined) firstConnection = socket;
      },
      onRegister(socket, _message, { state }) {
        socket.send(registeredMessage(state.registrations));
        const command = JSON.stringify({
          type: "command",
          protocolVersion: 1,
          bountyId: "bty-component",
          vmId: "vm-component",
          commandId: "cmd-duplicate",
          issuedAt: "2026-07-29T00:00:01.000Z",
          command: { type: "resume" },
        });
        socket.send(command);
        socket.send(command);
      },
      onMessage(socket, message, { state, received }) {
        if (message.type === "event" && state.registrations >= 2) {
          socket.send(
            JSON.stringify({
              type: "event_acknowledged",
              protocolVersion: 1,
              bountyId: "bty-component",
              vmId: "vm-component",
              acknowledgedThrough: message.sequence,
            }),
          );
        } else if (
          message.type === "heartbeat" &&
          socket === firstConnection &&
          received.filter((entry) => entry.type === "command_result").length >= 2
        ) {
          socket.close(1012, "force reconnect");
        }
      },
    });

    harness = await startSwordfishHarness("protocol", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      await waitFor(() => peer.state.registrations >= 1, "initial registration");
      await waitFor(
        () => peer.received.filter((message) => message.type === "command_result").length >= 2,
        "initial command results",
      );
      await waitFor(() => peer.received.some((message) => message.type === "heartbeat"), "a heartbeat");
      await waitFor(() => peer.state.registrations >= 2, "a reconnect");
      await waitFor(
        () => peer.received.filter((message) => message.type === "command_result").length >= 4,
        "deduplicated command results",
      );

      // Every frame is contract-decoded by the fake peer, so these are exact assertions.
      expect(peer.decodeErrors).toEqual([]);
      expect(peer.protocols.length).toBeGreaterThanOrEqual(2);
      expect(peer.protocols.every((protocol) => protocol === "bebop-token.component-token")).toBe(true);
      const registers = peer.received.filter((message) => message.type === "register");
      expect(registers.length).toBeGreaterThanOrEqual(2);
      for (const register of registers) {
        expect(register).toMatchObject({
          protocolVersion: 1,
          bountyId: "bty-component",
          vmId: "vm-component",
          swordfishVersion: "0.0.0",
          lastProducedEventSequence: 1,
        });
      }
      const heartbeats = peer.received.filter((message) => message.type === "heartbeat");
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
      for (const heartbeat of heartbeats) {
        expect(heartbeat).toMatchObject({
          protocolVersion: 1,
          bountyId: "bty-component",
          vmId: "vm-component",
          lastProducedEventSequence: 1,
        });
      }
      expect(heartbeats.some((heartbeat) => heartbeat.lastAppliedCommandId === "cmd-duplicate")).toBe(true);
      const results = peer.received.filter((message) => message.type === "command_result");
      expect(results.length).toBeGreaterThanOrEqual(4);
      for (const result of results) {
        expect(result).toMatchObject({
          protocolVersion: 1,
          bountyId: "bty-component",
          vmId: "vm-component",
          commandId: "cmd-duplicate",
          // Rejected, and identically so every time: nothing is outstanding for a `resume` to clear, and a
          // redelivery replays the recorded answer rather than deciding again.
          status: "rejected",
        });
      }
      const eventSequences = peer.received.filter((message) => message.type === "event").map((event) => event.sequence);
      expect(eventSequences.length).toBeGreaterThanOrEqual(2);
      expect(new Set(eventSequences)).toEqual(new Set([1]));
      await waitFor(
        async () =>
          (await harness?.run(Effect.flatMap(SwordfishStore, (store) => store.deliveryState)))?.acknowledgedThrough ===
          1,
        "the durable acknowledgement",
      );

      const durable = await harness.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* SwordfishStore;
          const commands = yield* sql`SELECT command_id, result_payload FROM applied_commands`;
          return { delivery: yield* store.deliveryState, commands };
        }),
      );
      expect(durable.delivery.acknowledgedThrough).toBe(1);
      // The redelivered command is applied once and answered twice from its recorded result. That the recorded
      // result is a rejection is the point: nothing is outstanding for a `resume` to clear, and the second
      // delivery must replay that answer rather than re-deciding it.
      expect(durable.commands).toHaveLength(1);
      expect(JSON.parse(String(durable.commands[0]?.["result_payload"]))).toMatchObject({
        commandId: "cmd-duplicate",
        status: "rejected",
      });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 20_000);

  test("reconnects when a peer closes before registration", async () => {
    const peer = startFakePeer({
      onOpen(socket) {
        socket.close(1000, "no registration");
      },
    });
    harness = await startSwordfishHarness("pre-registration-close", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      await waitFor(() => peer.state.connections >= 2, "reconnect after a pre-registration close");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 10_000);

  test("replays retained events when Bebop's durable cursor regresses", async () => {
    let firstConnection: FakePeerSocket | undefined;
    const peer = startFakePeer({
      onOpen(socket) {
        if (firstConnection === undefined) firstConnection = socket;
      },
      onRegister(socket, _message, { state }) {
        // Every registration reports cursor 0: after the first connection acknowledged
        // sequence 1, a forced close simulates Bebop restoring behind Swordfish's cursor.
        socket.send(registeredMessage(state.registrations));
      },
      onMessage(socket, message, { state }) {
        if (message.type === "event" && state.registrations === 1) {
          socket.send(
            JSON.stringify({
              type: "event_acknowledged",
              protocolVersion: 1,
              bountyId: "bty-component",
              vmId: "vm-component",
              acknowledgedThrough: message.sequence,
            }),
          );
        }
      },
    });
    harness = await startSwordfishHarness("cursor-regression", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      await waitFor(
        async () =>
          (await harness?.run(Effect.flatMap(SwordfishStore, (store) => store.deliveryState)))?.acknowledgedThrough ===
          1,
        "the first durable acknowledgement",
      );
      firstConnection?.close(1012, "reconnect with regressed cursor");
      await waitFor(() => peer.state.registrations >= 2, "the second registration");
      await waitFor(
        () => peer.received.filter((message) => message.type === "event").length >= 2,
        "the retained event replay",
      );
      expect(peer.decodeErrors).toEqual([]);
      expect(peer.received.filter((message) => message.type === "event").map((event) => event.sequence)).toEqual([
        1, 1,
      ]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 10_000);

  test("tracks never-connected, connected, and disconnected with the next attempt due", async () => {
    // The live connection is reported rather than stored: `sf status` can say "never connected
    // since start", "disconnected since X, retry in Y", or "connected", and the difference
    // between a daemon that has not reached Bebop yet and one that reached it and lost it is
    // exactly the distinction a retrying-with-backoff daemon needs to make visible.
    let firstConnection: FakePeerSocket | undefined;
    const peer = startFakePeer({
      onOpen(socket) {
        if (firstConnection === undefined) firstConnection = socket;
      },
      onRegister(socket, _message, { state }) {
        socket.send(registeredMessage(state.registrations));
      },
    });

    harness = await startSwordfishHarness("connection-state-live", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const read = async () => {
      const current = harness;
      if (current === undefined) throw new Error("harness is not started");
      return current.run(Effect.flatMap(BebopConnectionState, (state) => state.current));
    };
    const fiber = harness.fork(runBebopClient);
    try {
      // The daemon starts never-connected and reports it until the first registration lands.
      await waitFor(async () => (await read()).kind === "connected", "the first registration");
      const connected = await read();
      expect(connected.kind).toBe("connected");

      // A forced close after registration reports disconnected with a next attempt due.
      firstConnection?.close(1012, "force disconnect");
      await waitFor(async () => (await read()).kind === "disconnected", "the disconnect state");
      const disconnected = await read();
      if (disconnected.kind === "disconnected") {
        expect(disconnected.nextAttemptAt > disconnected.disconnectedSince).toBe(true);
      }

      // And it recovers back to connected on the next registration.
      await waitFor(async () => (await read()).kind === "connected", "the reconnect registration");
      expect(peer.decodeErrors).toEqual([]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 10_000);

  test("does not retry defects from connection-state bookkeeping", async () => {
    const peer = startFakePeer({
      onRegister(socket, _message, { state }) {
        socket.send(registeredMessage(state.registrations));
      },
      onMessage(socket, message) {
        if (message.type === "heartbeat") {
          socket.close(1012, "trigger disconnect bookkeeping");
        }
      },
    });
    harness = await startSwordfishHarness("connection-state-defect", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const realConnectionState = await harness.run(BebopConnectionState);
    const fiber = harness.fork(
      runBebopClient.pipe(
        Effect.provideService(BebopConnectionState, {
          ...realConnectionState,
          markLost: () => Effect.die("connection-state defect"),
        }),
      ),
    );
    try {
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("connection-state defect");
      await Bun.sleep(100);
      expect(peer.state.connections).toBe(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 10_000);

  test("reconnects when the peer registers a foreign identity", async () => {
    const peer = startFakePeer({
      onRegister(socket) {
        socket.send(
          JSON.stringify({
            type: "registered",
            protocolVersion: 1,
            connectionId: "conn-foreign",
            bountyId: "bty-someone-else",
            vmId: "vm-someone-else",
            serverTime: "2026-07-29T00:00:00.000Z",
            acknowledgedThrough: 0,
          }),
        );
      },
    });
    harness = await startSwordfishHarness("foreign-identity", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      await waitFor(() => peer.state.registrations >= 2, "reconnect after a foreign registration");
      expect(peer.decodeErrors).toEqual([]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 10_000);

  test("reconnects when the peer acknowledges beyond the produced frontier", async () => {
    const peer = startFakePeer({
      onRegister(socket, _message, { state }) {
        socket.send(registeredMessage(state.registrations, 99));
      },
    });
    harness = await startSwordfishHarness("ack-ahead", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      await waitFor(() => peer.state.registrations >= 2, "reconnect after an acknowledgement ahead");
      expect(peer.decodeErrors).toEqual([]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 10_000);

  test("reconnects after malformed, oversized, and repeated-registration frames", async () => {
    let phase: "malformed" | "oversized" | "repeated" = "malformed";
    const peer = startFakePeer({
      onRegister(socket, _message, { state }) {
        socket.send(registeredMessage(state.registrations));
        if (phase === "malformed") {
          socket.send("this is not json");
          phase = "oversized";
        } else if (phase === "oversized") {
          socket.send("x".repeat(1_100_000));
          phase = "repeated";
        } else {
          socket.send(registeredMessage(state.registrations));
          phase = "malformed";
        }
      },
    });
    harness = await startSwordfishHarness("bad-frames", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      // Each poisoned frame kills its session, so three registrations means the daemon
      // survived all three and came back every time.
      await waitFor(() => peer.state.registrations >= 3, "reconnects after each poisoned frame");
      expect(peer.decodeErrors).toEqual([]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 10_000);

  test("closes the socket when a peer saturates the inbound queue", async () => {
    const closeCodes: Array<number> = [];
    const peer = startFakePeer({
      onRegister(socket, _message, { state }) {
        socket.send(registeredMessage(state.registrations));
        // Flood valid acknowledgements fast enough to fill the bounded queue before the
        // consumer can drain a single item past capacity. The read loop closes with 1008
        // (policy violation: "inbound queue full").
        const ack = JSON.stringify({
          type: "event_acknowledged",
          protocolVersion: 1,
          bountyId: "bty-component",
          vmId: "vm-component",
          acknowledgedThrough: 1,
        });
        for (let index = 0; index < 128; index += 1) {
          socket.send(ack);
        }
      },
      onClose(code) {
        closeCodes.push(code);
      },
    });
    harness = await startSwordfishHarness("queue-saturation", {
      bebopWebSocketUrl: `ws://127.0.0.1:${peer.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      await waitFor(() => closeCodes.includes(1008), "the inbound-queue close");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      peer.stop();
    }
  }, 10_000);
});
