// The server half of the spike: the miniature bebop API plus the WebSocket endpoint
// Swordfish connects back on (SPEC section 18.1).
//
// Both are mounted on one Bun HTTP server, which is how the real bebop process will run
// them -- the Swordfish gateway and the public API share a port in the deployment described
// in SPEC section 24.

import { Effect, Layer, Redacted, Schedule, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Socket } from "effect/unstable/socket";

import { BearerAuthentication, SpikeApi, type SpikeEventEnvelope } from "./api.ts";

export const VALID_TOKEN = "spike-bearer-token";

/** The events a client would find already stored when it connects or reconnects. */
export const STORED_EVENTS: ReadonlyArray<SpikeEventEnvelope> = [1, 2, 3, 4, 5].map((cursor) => ({
  cursor,
  kind: "stored" as const,
}));

const LIVE_EVENT_COUNT = 3;
const LIVE_EVENT_INTERVAL = "120 millis";

// A security middleware in Effect 4 *wraps* the endpoint effect rather than merely
// validating a credential: it receives the endpoint's effect and must return it to let the
// request proceed. Returning something else -- or forgetting to return it at all -- skips
// the handler silently, so this shape is worth getting right once.
const authentication = Layer.succeed(BearerAuthentication)(
  BearerAuthentication.of({
    bearer: (httpEffect, { credential }) =>
      Redacted.value(credential) === VALID_TOKEN
        ? httpEffect
        : Effect.fail({ code: "unauthorized" as const, message: "bad bearer token" }),
  }),
);

const handlers = HttpApiBuilder.group(SpikeApi, "spike", (handlers) =>
  handlers
    .handle("health", () => Effect.succeed({ status: "ok" as const, checkedAt: new Date().toISOString() }))
    .handle("createThing", ({ payload }) => Effect.succeed({ name: payload.name, count: payload.count }))
    .handle("streamEvents", ({ headers }) => {
      // Replay-then-live with a single cursor source, as Milestone 2 decided: `Last-Event-ID`
      // is the only place a client says where it left off.
      const lastEventId = headers["last-event-id"];
      const after = lastEventId === undefined ? 0 : Number(lastEventId);
      const replay = Stream.fromIterable(STORED_EVENTS.filter((event) => event.cursor > after));

      const live = Stream.range(1, LIVE_EVENT_COUNT).pipe(
        Stream.schedule(Schedule.spaced(LIVE_EVENT_INTERVAL)),
        Stream.map((n): SpikeEventEnvelope => ({ cursor: STORED_EVENTS.length + n, kind: "live" })),
      );

      // Concatenation is what makes the handoff race-free: the live stream is not
      // subscribed to until replay has finished emitting.
      return Effect.succeed(
        Stream.concat(replay, live).pipe(
          Stream.map((data) => ({ id: String(data.cursor), event: "spike_event" as const, data })),
        ),
      );
    }),
);

/** Echoes back what it receives, prefixed, and refuses anything oversized. */
const MAX_FRAME_BYTES = 64;

const websocketRoute = HttpRouter.use((router) =>
  router.add(
    "GET",
    "/swordfish",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      const write = yield* socket.writer;

      yield* socket.runString((message) =>
        message.length > MAX_FRAME_BYTES
          ? // Fail closed: refuse the frame and close the connection rather than
            // buffering an unbounded message or letting it reach the reducer.
            write("rejected:oversized").pipe(Effect.andThen(write(new Socket.CloseEvent(1009, "message too big"))))
          : write(`echo:${message}`),
      );

      return HttpServerResponse.empty();
    }).pipe(
      Effect.scoped,
      // A client that disconnects interrupts this fiber. That is ordinary, not an error,
      // and it must not take the server down with it.
      Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty())),
    ),
  ),
);

export const app = Layer.mergeAll(
  HttpApiBuilder.layer(SpikeApi).pipe(Layer.provide(handlers), Layer.provide(authentication)),
  websocketRoute,
).pipe(Layer.provide(HttpRouter.layer));
