import { Effect, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { SwordfishStore } from "#src/persistence/store.ts";
import { runBebopClient } from "#src/protocol/client.ts";
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

describe("Swordfish outbound protocol", () => {
  test("registers, replays, reconnects, heartbeats, acknowledges, and deduplicates commands", async () => {
    const received: Array<Record<string, unknown>> = [];
    const protocols: Array<string | null> = [];
    let registrations = 0;
    let firstConnection: Bun.ServerWebSocket<unknown> | undefined;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const protocol = request.headers.get("sec-websocket-protocol");
        protocols.push(protocol);
        const upgraded = bunServer.upgrade(request, {
          headers: protocol === null ? undefined : { "sec-websocket-protocol": protocol },
        });
        return upgraded ? undefined : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          if (firstConnection === undefined) firstConnection = socket;
        },
        message(socket, data) {
          const message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<
            string,
            unknown
          >;
          received.push(message);
          if (message["type"] === "register") {
            registrations += 1;
            socket.send(
              JSON.stringify({
                type: "registered",
                protocolVersion: 1,
                connectionId: `conn-${registrations}`,
                bountyId: "bty-component",
                vmId: "vm-component",
                serverTime: "2026-07-29T00:00:00.000Z",
                acknowledgedThrough: 0,
              }),
            );
            const command = JSON.stringify({
              type: "command",
              protocolVersion: 1,
              bountyId: "bty-component",
              vmId: "vm-component",
              commandId: "cmd-duplicate",
              issuedAt: "2026-07-29T00:00:01.000Z",
              command: { type: "extend_constraint", constraint: "primary_turns" },
            });
            socket.send(command);
            socket.send(command);
          } else if (message["type"] === "event") {
            if (registrations >= 2) {
              socket.send(
                JSON.stringify({
                  type: "event_acknowledged",
                  protocolVersion: 1,
                  bountyId: "bty-component",
                  vmId: "vm-component",
                  acknowledgedThrough: message["sequence"],
                }),
              );
            }
          } else if (
            message["type"] === "heartbeat" &&
            socket === firstConnection &&
            received.filter((entry) => entry["type"] === "command_result").length >= 2
          ) {
            socket.close(1012, "force reconnect");
          }
        },
      },
    });

    harness = await startSwordfishHarness("protocol", {
      bebopWebSocketUrl: `ws://127.0.0.1:${server.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      await waitFor(() => registrations >= 1, "initial registration");
      await waitFor(
        () => received.filter((message) => message["type"] === "command_result").length >= 2,
        "initial command results",
      );
      await waitFor(() => received.some((message) => message["type"] === "heartbeat"), "a heartbeat");
      await waitFor(() => registrations >= 2, "a reconnect");
      await waitFor(
        () => received.filter((message) => message["type"] === "command_result").length >= 4,
        "deduplicated command results",
      );
      expect(protocols.every((protocol) => protocol === "bebop-token.component-token")).toBe(true);
      expect(received.some((message) => message["type"] === "heartbeat")).toBe(true);
      const eventSequences = received
        .filter((message) => message["type"] === "event")
        .map((message) => message["sequence"]);
      expect(eventSequences.length).toBeGreaterThanOrEqual(1);
      expect(new Set(eventSequences)).toEqual(new Set([1]));
      expect(eventSequences.length).toBeGreaterThanOrEqual(2);
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
          const commands = yield* sql`SELECT count(*) AS count FROM applied_commands`;
          const constraint = yield* sql`
            SELECT extensions_granted FROM constraint_ledger WHERE constraint_key = 'primary_turns'
          `;
          return {
            delivery: yield* store.deliveryState,
            commandCount: commands[0]?.["count"],
            extensions: constraint[0]?.["extensions_granted"],
          };
        }),
      );
      expect(durable.delivery.acknowledgedThrough).toBe(1);
      expect(durable.commandCount).toBe(1);
      expect(durable.extensions).toBe(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      void server.stop(true);
    }
  }, 20_000);

  test("reconnects when a peer closes before registration", async () => {
    let connections = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const protocol = request.headers.get("sec-websocket-protocol");
        const upgraded = bunServer.upgrade(request, {
          headers: protocol === null ? undefined : { "sec-websocket-protocol": protocol },
        });
        return upgraded ? undefined : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          connections += 1;
          socket.close(1000, "no registration");
        },
        message() {},
      },
    });
    harness = await startSwordfishHarness("pre-registration-close", {
      bebopWebSocketUrl: `ws://127.0.0.1:${server.port}/swordfish`,
    });
    const fiber = harness.fork(runBebopClient);
    try {
      await waitFor(() => connections >= 2, "reconnect after a pre-registration close");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      void server.stop(true);
    }
  }, 10_000);

  test("replays retained events when Bebop's durable cursor regresses", async () => {
    const eventSequences: Array<number> = [];
    let registrations = 0;
    let firstConnection: Bun.ServerWebSocket<unknown> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const protocol = request.headers.get("sec-websocket-protocol");
        const upgraded = bunServer.upgrade(request, {
          headers: protocol === null ? undefined : { "sec-websocket-protocol": protocol },
        });
        return upgraded ? undefined : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          if (firstConnection === undefined) firstConnection = socket;
        },
        message(socket, data) {
          const message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<
            string,
            unknown
          >;
          if (message["type"] === "register") {
            registrations += 1;
            socket.send(
              JSON.stringify({
                type: "registered",
                protocolVersion: 1,
                connectionId: `conn-regression-${registrations}`,
                bountyId: "bty-component",
                vmId: "vm-component",
                serverTime: "2026-07-29T00:00:00.000Z",
                acknowledgedThrough: 0,
              }),
            );
          } else if (message["type"] === "event" && typeof message["sequence"] === "number") {
            eventSequences.push(message["sequence"]);
            if (registrations === 1) {
              socket.send(
                JSON.stringify({
                  type: "event_acknowledged",
                  protocolVersion: 1,
                  bountyId: "bty-component",
                  vmId: "vm-component",
                  acknowledgedThrough: message["sequence"],
                }),
              );
            }
          }
        },
      },
    });
    harness = await startSwordfishHarness("cursor-regression", {
      bebopWebSocketUrl: `ws://127.0.0.1:${server.port}/swordfish`,
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
      await waitFor(() => registrations >= 2 && eventSequences.length >= 2, "the retained event replay");
      expect(eventSequences).toEqual([1, 1]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      void server.stop(true);
    }
  }, 10_000);

  test("does not retry defects from durable disconnect bookkeeping", async () => {
    let connections = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const protocol = request.headers.get("sec-websocket-protocol");
        const upgraded = bunServer.upgrade(request, {
          headers: protocol === null ? undefined : { "sec-websocket-protocol": protocol },
        });
        return upgraded ? undefined : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          connections += 1;
          socket.close(1012, "trigger disconnect bookkeeping");
        },
        message() {},
      },
    });
    harness = await startSwordfishHarness("durable-defect", {
      bebopWebSocketUrl: `ws://127.0.0.1:${server.port}/swordfish`,
    });
    const realStore = await harness.run(SwordfishStore);
    const fiber = harness.fork(
      runBebopClient.pipe(
        Effect.provideService(SwordfishStore, {
          ...realStore,
          setConnected: () => Effect.die("durable disconnect defect"),
        }),
      ),
    );
    try {
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("durable disconnect defect");
      await Bun.sleep(100);
      expect(connections).toBe(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      void server.stop(true);
    }
  }, 10_000);
});
