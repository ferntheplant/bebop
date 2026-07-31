// Spike driver: do Effect's HTTP, SSE, WebSocket, and CLI modules actually run as
// processes on the pinned Bun?
//
// Milestone 2 built the bebop contracts with these modules and generated OpenAPI from
// them, which proves the schemas type-check and encode. It does not prove that a server
// built from them starts, that SSE replay is race-free, that a WebSocket survives a
// reconnect, or that a CLI can report failure with a nonzero status. Milestones 3, 4, and 5
// all assume those four things.

import { BunHttpServer, BunSocket } from "@effect/platform-bun";
import { spawn } from "bun";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { OpenApi } from "effect/unstable/httpapi";
import { Socket } from "effect/unstable/socket";

import { SpikeApi } from "./api.ts";
import { app, STORED_EVENTS, VALID_TOKEN } from "./server.ts";

const here = import.meta.dir;

// --- probe harness ------------------------------------------------------------------

interface ProbeResult {
  readonly area: "http" | "sse" | "websocket" | "cli";
  readonly id: string;
  readonly question: string;
  readonly pass: boolean;
  readonly observed: unknown;
}

const results: Array<ProbeResult> = [];

const probe = async (
  area: ProbeResult["area"],
  id: string,
  question: string,
  body: () => Promise<{ readonly pass: boolean; readonly observed: unknown }>,
): Promise<void> => {
  let outcome: { pass: boolean; observed: unknown };
  try {
    outcome = await body();
  } catch (error) {
    outcome = { pass: false, observed: { unexpectedFailure: String(error) } };
  }
  results.push({ area, id, question, ...outcome });
  process.stdout.write(
    `  ${outcome.pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${question}\n` +
      `              ${JSON.stringify(outcome.observed)}\n`,
  );
};

// --- SSE client -----------------------------------------------------------------------

interface SseFrame {
  readonly id: string;
  readonly data: { readonly cursor: number; readonly kind: string };
}

/** Reads an SSE response to completion and returns its frames in arrival order. */
const readSse = async (url: string, lastEventId?: string): Promise<Array<SseFrame>> => {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${VALID_TOKEN}`,
      ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
    },
  });
  const text = await response.text();
  const frames: Array<SseFrame> = [];
  for (const block of text.split("\n\n")) {
    const id = /^id: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (id === undefined || data === undefined) continue;
    frames.push({ id, data: JSON.parse(data) as SseFrame["data"] });
  }
  return frames;
};

// --- CLI ------------------------------------------------------------------------------

const runCli = async (...args: Array<string>) => {
  const child = spawn(["bun", `${here}/cli.ts`, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
};

// --- driver ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const port = (server.address as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/swordfish`;

  const authorized = { authorization: `Bearer ${VALID_TOKEN}` };

  process.stdout.write(`server: ${base}\n\nhttp (bebop api shape)\n`);

  yield* Effect.promise(async () => {
    await probe("http", "H1", "a bearer-authenticated route responds with a decodable payload", async () => {
      const response = await fetch(`${base}/api/health`, { headers: authorized });
      const body: unknown = await response.json();
      const decoded = Schema.decodeUnknownResult(Schema.Struct({ status: Schema.Literal("ok") }))(body);
      return {
        pass: response.status === 200 && decoded._tag === "Success",
        observed: { status: response.status, body },
      };
    });

    await probe("http", "H2", "a missing bearer token is refused with the declared typed error", async () => {
      const response = await fetch(`${base}/api/health`);
      const body: unknown = await response.json();
      return {
        pass: response.status === 401 && (body as { code?: string }).code === "unauthorized",
        observed: { status: response.status, body },
      };
    });

    await probe("http", "H3", "a wrong bearer token is refused", async () => {
      const response = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer nope" } });
      return { pass: response.status === 401, observed: { status: response.status } };
    });

    await probe(
      "http",
      "H4",
      "a payload violating its schema is refused at the boundary, not in the handler",
      async () => {
        const response = await fetch(`${base}/api/things`, {
          method: "POST",
          headers: { ...authorized, "content-type": "application/json" },
          body: JSON.stringify({ name: "no", count: -1 }),
        });
        const body: unknown = await response.json();
        return {
          // 4xx, not 500: the request never reached handler code.
          pass: response.status >= 400 && response.status < 500,
          observed: { status: response.status, body },
        };
      },
    );

    await probe("http", "H5", "OpenAPI generated from the served api declares bearer security", async () => {
      const document = OpenApi.fromApi(SpikeApi);
      const schemes = Object.keys(document.components?.securitySchemes ?? {});
      const healthGet = document.paths["/api/health"]?.get;
      return {
        pass: schemes.length > 0 && Array.isArray(healthGet?.security) && healthGet.security.length > 0,
        observed: { securitySchemes: schemes, healthSecurity: healthGet?.security },
      };
    });

    process.stdout.write("\nsse (cursor replay then live)\n");

    await probe("sse", "S1", "a fresh stream delivers every stored event in order, id equal to cursor", async () => {
      const frames = await readSse(`${base}/api/events`);
      const cursors = frames.map((f) => f.data.cursor);
      const idsMatchCursors = frames.every((f) => f.id === String(f.data.cursor));
      return {
        pass:
          idsMatchCursors &&
          JSON.stringify(cursors) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]) &&
          frames.slice(0, 5).every((f) => f.data.kind === "stored"),
        observed: { cursors, idsMatchCursors, kinds: frames.map((f) => f.data.kind) },
      };
    });

    await probe(
      "sse",
      "S2",
      "Last-Event-ID replays from the cursor and continues live with no gap or duplicate",
      async () => {
        const frames = await readSse(`${base}/api/events`, "3");
        const cursors = frames.map((f) => f.data.cursor);
        const contiguous = cursors.every((cursor, index) => index === 0 || cursor === (cursors[index - 1] ?? 0) + 1);
        const noneReplayed = cursors.every((cursor) => cursor > 3);
        const reachedLive = frames.some((f) => f.data.kind === "live");
        return {
          pass: contiguous && noneReplayed && reachedLive && cursors[0] === 4,
          observed: { cursors, contiguous, noneReplayed, reachedLive },
        };
      },
    );

    await probe("sse", "S3", "an unknown cursor past the stored range yields only live events", async () => {
      const frames = await readSse(`${base}/api/events`, String(STORED_EVENTS.length));
      return {
        pass: frames.length > 0 && frames.every((f) => f.data.kind === "live"),
        observed: { cursors: frames.map((f) => f.data.cursor), kinds: frames.map((f) => f.data.kind) },
      };
    });
  });

  process.stdout.write("\nwebsocket (swordfish-direction channel)\n");

  /** Opens a client socket, sends each message, collects replies, then closes. */
  const exchange = (messages: ReadonlyArray<string>, waitMs: number) =>
    Effect.gen(function* () {
      const received: Array<string> = [];
      const socket = yield* Socket.Socket;
      const write = yield* socket.writer;
      yield* Effect.forkScoped(
        socket.runString((message) => {
          received.push(message);
        }),
      );
      yield* Effect.sleep("150 millis");
      for (const message of messages) yield* write(message);
      yield* Effect.sleep(`${waitMs} millis`);
      return received;
    }).pipe(Effect.scoped, Effect.provide(BunSocket.layerWebSocket(wsUrl)));

  const firstConnection = yield* exchange(["register", "heartbeat"], 400);
  yield* Effect.promise(async () => {
    await probe("websocket", "W1", "an outbound client round-trips framed messages in both directions", async () => ({
      pass: firstConnection.includes("echo:register") && firstConnection.includes("echo:heartbeat"),
      observed: { received: firstConnection },
    }));
  });

  // The first connection's scope has closed, so this is a genuinely new socket against a
  // server that has already seen a client come and go.
  const secondConnection = yield* exchange(["after-reconnect"], 400);
  yield* Effect.promise(async () => {
    await probe("websocket", "W2", "a new connection after a disconnect works and the server stayed up", async () => ({
      pass: secondConnection.includes("echo:after-reconnect"),
      observed: { received: secondConnection },
    }));
  });

  const oversized = yield* exchange(["x".repeat(200)], 400);
  const afterOversized = yield* exchange(["still-alive"], 400);
  yield* Effect.promise(async () => {
    await probe("websocket", "W3", "an oversized frame fails closed without taking the server down", async () => ({
      pass: oversized.includes("rejected:oversized") && afterOversized.includes("echo:still-alive"),
      observed: { oversizedReply: oversized, subsequentConnection: afterOversized },
    }));

    process.stdout.write("\ncli (sf / bebop executables)\n");

    await probe("cli", "C1", "a subcommand parses its flags and exits 0", async () => {
      const outcome = await runCli("status", "--bounty", "bnt_1", "--verbose");
      return {
        pass: outcome.exitCode === 0 && outcome.stdout === "status bounty=bnt_1 verbose=true",
        observed: outcome,
      };
    });

    await probe("cli", "C2", "an unknown flag exits nonzero and prints usage", async () => {
      const outcome = await runCli("status", "--nope");
      return {
        pass: outcome.exitCode !== 0 && `${outcome.stdout}${outcome.stderr}`.includes("USAGE"),
        observed: { exitCode: outcome.exitCode, output: `${outcome.stdout}${outcome.stderr}`.slice(0, 120) },
      };
    });

    await probe("cli", "C3", "a failing command exits nonzero rather than reporting success", async () => {
      const outcome = await runCli("fail");
      return {
        pass: outcome.exitCode !== 0,
        observed: { exitCode: outcome.exitCode, stderr: outcome.stderr.split("\n")[0] },
      };
    });
  });
});

// The server and the probes share one process and one ephemeral port, and the whole thing
// lives in a scope so an interrupted run cannot leave a listener behind.
//
// Closing that scope interrupts the still-listening server fiber, and Effect reports the
// interrupt as a failed exit. That is the expected shape of a clean shutdown here, so an
// interrupt-only cause is accepted and anything else is re-raised.
const exit = await Effect.runPromise(
  Effect.exit(
    program.pipe(
      Effect.provide(HttpRouter.serve(app).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0 })))),
      Effect.scoped,
    ),
  ),
);

if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
  process.stdout.write(`\nspike aborted: ${String(Cause.squash(exit.cause))}\n`);
  process.exitCode = 1;
}

await Bun.write(`${here}/results.json`, `${JSON.stringify({ results }, null, 2)}\n`);

const failed = results.filter((r) => !r.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} probes passed\n`);
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.map((r) => r.id).join(", ")}\n`);
  process.exitCode = 1;
}
