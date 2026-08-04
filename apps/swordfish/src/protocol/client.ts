import type { BebopToSwordfishMessage, RegisteredMessage, SwordfishToBebopMessage } from "@bebop/contracts";
import {
  currentProtocolVersion,
  decodeBebopToSwordfishMessage,
  SwordfishToBebopMessage as SwordfishToBebopMessageSchema,
  toEventSequence,
} from "@bebop/contracts";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Data, Duration, Effect, Fiber, Queue, Redacted, Schedule, Schema, Semaphore } from "effect";
import { Socket } from "effect/unstable/socket";
import type { SqlError } from "effect/unstable/sql";

import { SwordfishConfiguration } from "#src/config.ts";
import { ShutdownSignal } from "#src/daemon/shutdown.ts";
import { SwordfishIdentity } from "#src/domain/identity.ts";
import type { AcknowledgementError } from "#src/persistence/store.ts";
import { SwordfishStore } from "#src/persistence/store.ts";
import type { CommandConflictError, WorkflowTransitionError } from "#src/workflow/service.ts";
import { WorkflowService } from "#src/workflow/service.ts";

const inboundCapacity = 64;
const maxFrameLength = 1_048_576;
const encodeOutbound = Schema.encodeUnknownSync(SwordfishToBebopMessageSchema);

export class BebopSessionError extends Data.TaggedError("BebopSessionError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

// Malformed or oversized peer traffic is an expected session failure, not a defect:
// throwing these values would turn them into defects that supervision cannot retry.
const decodeFrame = (frame: string): Effect.Effect<BebopToSwordfishMessage, BebopSessionError> => {
  if (new TextEncoder().encode(frame).byteLength > maxFrameLength) {
    return Effect.fail(new BebopSessionError({ reason: "Bebop sent an oversized frame." }));
  }
  return Effect.try({
    try: () => decodeBebopToSwordfishMessage(JSON.parse(frame) as unknown),
    catch: (cause) => new BebopSessionError({ reason: "Bebop sent an invalid protocol message.", cause }),
  });
};

const verifyIdentity = (
  message: Exclude<BebopToSwordfishMessage, { readonly type: "protocol_error" }>,
  config: { readonly bountyId: string; readonly vmId: string },
): Effect.Effect<void, BebopSessionError> =>
  "bountyId" in message && (message.bountyId !== config.bountyId || message.vmId !== config.vmId)
    ? Effect.fail(new BebopSessionError({ reason: "Bebop sent a message for a different bounty or VM." }))
    : Effect.void;

const session = (onRegistered: Effect.Effect<void>, heartbeatTick: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const config = yield* SwordfishConfiguration;
    const identity = yield* SwordfishIdentity;
    const store = yield* SwordfishStore;
    const workflow = yield* WorkflowService;
    const shutdown = yield* ShutdownSignal;
    const socket = yield* Socket.Socket;
    const write = yield* socket.writer;
    const inbound = yield* Queue.bounded<string>(inboundCapacity);

    const send = (message: SwordfishToBebopMessage) => write(JSON.stringify(encodeOutbound(message)));
    const socketFiber = yield* Effect.forkScoped(
      socket.runString((frame) => {
        if (!Queue.offerUnsafe(inbound, frame)) {
          return write(new Socket.CloseEvent(1008, "inbound queue full"));
        }
      }),
    );

    const socketEnded = Fiber.join(socketFiber).pipe(
      Effect.andThen(Effect.fail(new BebopSessionError({ reason: "Bebop closed the socket." }))),
    );
    const delivery = yield* store.deliveryState;
    yield* Effect.raceFirst(
      send({
        type: "register",
        protocolVersion: currentProtocolVersion,
        bountyId: config.bountyId,
        vmId: config.vmId,
        swordfishVersion: "0.0.0",
        lastProducedEventSequence: delivery.lastProduced,
      }),
      socketEnded,
    ).pipe(
      Effect.timeoutOrElse({
        duration: config.reconnectMaximumDelay,
        orElse: () => Effect.fail(new BebopSessionError({ reason: "Timed out opening the Bebop socket." })),
      }),
    );

    const first = yield* decodeFrame(
      yield* Effect.raceFirst(Queue.take(inbound), socketEnded).pipe(
        Effect.timeoutOrElse({
          duration: config.reconnectMaximumDelay,
          orElse: () => Effect.fail(new BebopSessionError({ reason: "Timed out waiting for Bebop registration." })),
        }),
      ),
    );
    if (first.type !== "registered") {
      return yield* Effect.fail(new BebopSessionError({ reason: "Bebop did not register this Swordfish connection." }));
    }
    yield* verifyIdentity(first, config);
    if (first.acknowledgedThrough > delivery.lastProduced) {
      return yield* Effect.fail(
        new BebopSessionError({ reason: "Bebop acknowledged an event Swordfish has not produced." }),
      );
    }

    const connectedAt = yield* identity.now;
    yield* store.acknowledge(first.acknowledgedThrough, connectedAt);
    yield* store.setConnected(true, connectedAt);
    yield* onRegistered;
    yield* Effect.logInfo("registered with Bebop").pipe(
      Effect.annotateLogs("connection_id", first.connectionId),
      Effect.annotateLogs("acknowledged_through", String(first.acknowledgedThrough)),
    );

    let sentThrough = first.acknowledgedThrough;
    const drainLock = yield* Semaphore.make(1);
    const drain = (producedThrough: typeof delivery.lastProduced) =>
      drainLock.withPermit(
        Effect.gen(function* () {
          while (sentThrough < producedThrough) {
            const events = yield* store.eventsAfter(sentThrough);
            if (events.length === 0) return;
            for (const event of events) {
              if (event.sequence > producedThrough) return;
              yield* send(event);
              sentThrough = toEventSequence(event.sequence);
            }
          }
        }),
      );
    yield* drain(delivery.lastProduced);

    const heartbeat = Effect.gen(function* () {
      yield* heartbeatTick;
      const current = yield* store.deliveryState;
      const sentAt = yield* identity.now;
      yield* send({
        type: "heartbeat",
        protocolVersion: currentProtocolVersion,
        bountyId: config.bountyId,
        vmId: config.vmId,
        sentAt,
        lastProducedEventSequence: current.lastProduced,
        ...(current.lastAppliedCommandId === undefined ? {} : { lastAppliedCommandId: current.lastAppliedCommandId }),
      });
      // Local workflow progress is allowed while Bebop is unavailable. The per-connection
      // send cursor drains each new event once; reconnect resets it to Bebop's durable cursor
      // and is the retry boundary for unacknowledged events.
      yield* drain(current.lastProduced);
    }).pipe(Effect.forever);
    const heartbeatFiber = yield* Effect.forkScoped(heartbeat);

    const handleRegistered = (_message: RegisteredMessage) =>
      Effect.fail(new BebopSessionError({ reason: "Bebop repeated registration on an active connection." }));

    const handle = (
      message: BebopToSwordfishMessage,
    ): Effect.Effect<
      void,
      | AcknowledgementError
      | BebopSessionError
      | CommandConflictError
      | Socket.SocketError
      | SqlError.SqlError
      | WorkflowTransitionError
    > =>
      Effect.gen(function* () {
        if (message.type === "protocol_error") {
          return yield* Effect.fail(
            new BebopSessionError({ reason: `Bebop protocol error (${message.code}): ${message.message}` }),
          );
        }
        yield* verifyIdentity(message, config);
        switch (message.type) {
          case "registered":
            return yield* handleRegistered(message);
          case "event_acknowledged": {
            const at = yield* identity.now;
            yield* store.acknowledge(message.acknowledgedThrough, at);
            const current = yield* store.deliveryState;
            yield* drain(current.lastProduced);
            return;
          }
          case "command": {
            const result = yield* workflow
              .applyCommand(message)
              .pipe(
                Effect.catchTag("WorkflowTransitionError", (error: WorkflowTransitionError) =>
                  Effect.fail(
                    new BebopSessionError({ reason: `A Bebop command violated the workflow: ${error.error.type}.` }),
                  ),
                ),
              );
            yield* send(result);
            if (message.command.type === "stop" && result.status === "completed") {
              yield* shutdown.request;
            }
            return;
          }
          default:
            return yield* Effect.fail(
              new BebopSessionError({ reason: `Bebop sent unsupported ${message.type} traffic.` }),
            );
        }
      });

    // Every session end is a typed failure: a clean close is a BebopSessionError, so the
    // reconnect loop never has to distinguish success-with-retry from failure-with-retry.
    yield* Effect.raceFirst(
      Effect.raceFirst(
        Effect.forever(Queue.take(inbound).pipe(Effect.flatMap(decodeFrame), Effect.flatMap(handle))),
        socketEnded,
      ),
      Fiber.join(heartbeatFiber),
    );
  }).pipe(
    Effect.catchTags({
      AcknowledgementError: (error: AcknowledgementError) =>
        Effect.fail(
          new BebopSessionError({
            reason: `Bebop acknowledged ${error.acknowledgedThrough} beyond ${error.lastProduced}.`,
            cause: error,
          }),
        ),
      CommandConflictError: (error: CommandConflictError) =>
        Effect.fail(
          new BebopSessionError({ reason: `Command id ${error.commandId} was reused with another payload.` }),
        ),
    }),
    Effect.scoped,
  );

function describeSessionFailure(failure: BebopSessionError | Socket.SocketError): string {
  if (failure._tag === "BebopSessionError") return failure.reason;
  return failure.reason.message;
}

export const runBebopClient = Effect.gen(function* () {
  const config = yield* SwordfishConfiguration;
  const identity = yield* SwordfishIdentity;
  const store = yield* SwordfishStore;
  const workflow = yield* WorkflowService;
  const heartbeatTicks = yield* Queue.bounded<void>(1);

  const reconnect = Effect.gen(function* () {
    let delay = Duration.toMillis(config.reconnectMinimumDelay);
    const maximum = Duration.toMillis(config.reconnectMaximumDelay);

    for (;;) {
      // `Effect.result` captures only typed failures; defects and interruption still
      // terminate the daemon for its supervisor instead of being retried forever.
      const outcome = yield* Effect.result(
        session(
          Effect.sync(() => (delay = Duration.toMillis(config.reconnectMinimumDelay))),
          Queue.take(heartbeatTicks),
        ).pipe(
          Effect.provide(
            BunSocket.layerWebSocket(config.bebopWebSocketUrl.href, {
              protocols: `bebop-token.${Redacted.value(config.bebopToken)}`,
              openTimeout: config.reconnectMaximumDelay,
            }),
          ),
        ),
      );
      // A session only ends in a typed failure: a clean close is mapped to
      // BebopSessionError inside `session`, so a success here is unreachable.
      if (outcome._tag === "Success") continue;
      if (outcome.failure._tag !== "BebopSessionError" && outcome.failure._tag !== "SocketError") {
        return yield* Effect.fail(outcome.failure);
      }
      const disconnectedAt = yield* identity.now;
      yield* store.setConnected(false, disconnectedAt);
      yield* Effect.logWarning("Bebop connection ended; reconnecting").pipe(
        Effect.annotateLogs("retry_delay_ms", String(delay)),
        Effect.annotateLogs("error_tag", outcome.failure._tag),
        Effect.annotateLogs("reason", describeSessionFailure(outcome.failure)),
      );
      yield* Effect.sleep(Duration.millis(delay));
      delay = Math.min(maximum, delay * 2);
    }
  });

  // This cadence outlives every connection. Its size-one signal queue drops redundant disconnected ticks, while
  // constraint evaluation keeps running and any reducer disagreement fails this client fiber for supervision.
  const heartbeatCadence = Effect.gen(function* () {
    yield* workflow.evaluateConstraints;
    Queue.offerUnsafe(heartbeatTicks, undefined);
  }).pipe(Effect.repeat(Schedule.spaced(config.heartbeatInterval)));
  yield* Effect.raceFirst(heartbeatCadence, reconnect);
});
