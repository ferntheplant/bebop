// Tailing `GET /api/bounties/:id/events` from the CLI.
//
// The generated client covers request/response endpoints; an SSE subscription is a long-lived
// response the CLI reads frame by frame. What matters for `ABSTRACT.md` §3.3 is that this uses
// the same route, the same cursor header, and the same event schema any other client would —
// each frame is decoded with `BountyEventEnvelope` from the contracts package, so a shape the
// CLI accepts is a shape the contract accepts.

import type { BountyEventEnvelope } from "@bebop/contracts";
import { BountyEventEnvelope as BountyEventEnvelopeSchema } from "@bebop/contracts";
import { Duration, Effect, Redacted, Schema } from "effect";

import type { CliConnection } from "#src/cli/client.ts";

export type CliEventFrame = BountyEventEnvelope;

class EventStreamError extends Error {
  readonly _tag = "EventStreamError";

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EventStreamError";
  }
}

function eventStreamError(message: string, retryable: boolean, options?: ErrorOptions): EventStreamError {
  return new EventStreamError(message, retryable, options);
}

const decodeEnvelope = Schema.decodeUnknownSync(BountyEventEnvelopeSchema);

/**
 * Follows a bounty's events until the stream ends or the process is interrupted.
 *
 * `Last-Event-ID` is the only cursor the client sends, matching the server's single source of
 * truth for where a subscriber left off.
 */
export const streamBountyEvents = Effect.fnUntraced(function* (options: {
  readonly connection: CliConnection;
  readonly bountyId: string;
  readonly lastEventId?: string;
  readonly onFrame: (frame: CliEventFrame) => Effect.Effect<void>;
}) {
  let cursor = options.lastEventId;
  for (;;) {
    const outcome = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const headers: Record<string, string> = { accept: "text/event-stream" };
          if (options.connection.token !== null) {
            headers["authorization"] = `Bearer ${Redacted.value(options.connection.token)}`;
          }
          if (cursor !== undefined) {
            headers["last-event-id"] = cursor;
          }

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${options.connection.baseUrl}/api/bounties/${encodeURIComponent(options.bountyId)}/events`, {
                headers,
              }),
            catch: (cause) => eventStreamError("The event stream could not be opened.", true, { cause }),
          });
          if (!response.ok) {
            const body = yield* Effect.promise(() => response.text());
            return yield* Effect.fail(
              eventStreamError(`The event stream was refused (${response.status}): ${body}`, false),
            );
          }
          if (response.body === null) {
            return yield* Effect.fail(eventStreamError("The event stream returned no body.", true));
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => undefined)));

          for (;;) {
            const chunk = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (cause) => eventStreamError("The event stream ended unexpectedly.", true, { cause }),
            });
            if (chunk.done) {
              return;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (data !== undefined) {
                const frame = yield* Effect.try({
                  try: () => decodeEnvelope(JSON.parse(data) as unknown),
                  catch: (cause) =>
                    eventStreamError("The server sent an event this client cannot read.", false, { cause }),
                });
                yield* options.onFrame(frame);
                cursor = String(frame.cursor);
              }
              boundary = buffer.indexOf("\n\n");
            }
          }
        }),
      ),
    );
    if (outcome._tag === "Failure" && !outcome.failure.retryable) {
      return yield* Effect.fail(outcome.failure);
    }
    yield* Effect.sleep(Duration.millis(500));
  }
});
