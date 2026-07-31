// A miniature of the bebop HTTP API, shaped exactly like the real one in
// `packages/contracts/src/http.ts`: bearer middleware on the whole API, typed error
// responses carried as schemas, and an SSE endpoint declared with `HttpApiSchema.StreamSse`
// whose event id must equal the event cursor.
//
// The spike does not serve the real `BebopHttpApi` because that would mean implementing
// every Milestone 3 handler. It serves the same *constructs*, which is what is unproven:
// Milestone 2 built these schemas and generated OpenAPI from them, but nothing has ever
// started a server with them on Bun.

import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

export const SpikeEventEnvelope = Schema.Struct({
  cursor: Schema.Number,
  kind: Schema.Literals(["stored", "live"]),
});
export type SpikeEventEnvelope = typeof SpikeEventEnvelope.Type;

const SseEventBase = Schema.Struct({
  id: Schema.String,
  event: Schema.Literal("spike_event"),
  data: Schema.fromJsonString(SpikeEventEnvelope),
});

// The same invariant Milestone 2 fixed for the real stream: "each canonical SSE ID must
// equal its typed event cursor". Encoding is where it gets enforced.
export const SpikeSseEvent = SseEventBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof SseEventBase.Type>((event) =>
      event.id === String(event.data.cursor) ? undefined : "Expected the SSE ID to match the event cursor",
    ),
  ),
);

const StreamError = Schema.Struct({ code: Schema.Literal("stream_error"), message: Schema.String });

function errorSchema<const Code extends string>(code: Code, status: HttpApiSchema.StatusLiteral) {
  return Schema.Struct({ code: Schema.Literal(code), message: Schema.String }).pipe(HttpApiSchema.status(status));
}

export const BadRequestError = errorSchema("bad_request", "BadRequest");
export const UnauthorizedError = errorSchema("unauthorized", "Unauthorized");

export class BearerAuthentication extends HttpApiMiddleware.Service<BearerAuthentication>()("BearerAuthentication", {
  security: { bearer: HttpApiSecurity.bearer },
  error: UnauthorizedError,
}) {}

export const HealthResponse = Schema.Struct({ status: Schema.Literal("ok"), checkedAt: Schema.String });

export const CreateThingRequest = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(3))),
  count: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
});

const HealthEndpoint = HttpApiEndpoint.get("health", "/api/health", {
  success: HealthResponse,
  error: [UnauthorizedError],
});

const CreateThingEndpoint = HttpApiEndpoint.post("createThing", "/api/things", {
  payload: CreateThingRequest,
  success: Schema.Struct({ name: Schema.String, count: Schema.Number }),
  error: [BadRequestError, UnauthorizedError],
});

const StreamEventsEndpoint = HttpApiEndpoint.get("streamEvents", "/api/events", {
  headers: { "last-event-id": Schema.optionalKey(Schema.String) },
  success: HttpApiSchema.StreamSse({ events: SpikeSseEvent, error: StreamError }),
  error: [UnauthorizedError],
});

export const SpikeApi = HttpApi.make("SpikeApi")
  .add(HttpApiGroup.make("spike").add(HealthEndpoint, CreateThingEndpoint, StreamEventsEndpoint))
  .middleware(BearerAuthentication);
