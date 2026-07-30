import type { BebopToSwordfishMessage, RegisteredMessage, SwordfishToBebopMessage } from "@bebop/contracts";
import {
  currentProtocolVersion,
  decodeBebopToSwordfishMessage,
  SwordfishToBebopMessage as SwordfishToBebopMessageSchema,
  toEventSequence,
} from "@bebop/contracts";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Data, Duration, Effect, Fiber, Queue, Redacted, Schedule, Schema } from "effect";
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

function decodeFrame(frame: string): BebopToSwordfishMessage {
  if (new TextEncoder().encode(frame).byteLength > maxFrameLength) {
    throw new BebopSessionError({ reason: "Bebop sent an oversized frame." });
  }
  try {
    return decodeBebopToSwordfishMessage(JSON.parse(frame) as unknown);
  } catch (cause) {
    throw new BebopSessionError({ reason: "Bebop sent an invalid protocol message.", cause });
  }
}

function verifyIdentity(
  message: Exclude<BebopToSwordfishMessage, { readonly type: "protocol_error" }>,
  config: { readonly bountyId: string; readonly vmId: string },
): void {
  if ("bountyId" in message && (message.bountyId !== config.bountyId || message.vmId !== config.vmId)) {
    throw new BebopSessionError({ reason: "Bebop sent a message for a different bounty or VM." });
  }
}

const session = (onRegistered: Effect.Effect<void>) =>
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
          return write(new Socket.CloseEvent(1013, "inbound queue full"));
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

    const first = decodeFrame(
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
    verifyIdentity(first, config);
    if (first.acknowledgedThrough < delivery.acknowledgedThrough) {
      return yield* Effect.fail(
        new BebopSessionError({ reason: "Bebop's acknowledgement cursor regressed behind durable local state." }),
      );
    }
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
    const drain = Effect.gen(function* () {
      const pending = yield* store.pendingEvents(sentThrough);
      for (const event of pending) {
        yield* send(event);
        sentThrough = toEventSequence(event.sequence);
      }
    });
    yield* drain;

    const heartbeat = Effect.gen(function* () {
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
      yield* drain;
    }).pipe(Effect.repeat(Schedule.spaced(config.heartbeatInterval)));
    yield* Effect.forkScoped(heartbeat);

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
    > => {
      if (message.type === "protocol_error") {
        return Effect.fail(
          new BebopSessionError({ reason: `Bebop protocol error (${message.code}): ${message.message}` }),
        );
      }
      verifyIdentity(message, config);
      switch (message.type) {
        case "registered":
          return handleRegistered(message);
        case "event_acknowledged":
          return identity.now.pipe(
            Effect.flatMap((at) => store.acknowledge(message.acknowledgedThrough, at)),
            Effect.andThen(drain),
          );
        case "command":
          return workflow
            .applyCommand(message)
            .pipe(
              Effect.flatMap((result) =>
                send(result).pipe(
                  Effect.andThen(
                    message.command.type === "stop" && result.status === "completed" ? shutdown.request : Effect.void,
                  ),
                ),
              ),
            );
        default:
          return Effect.fail(new BebopSessionError({ reason: `Bebop sent unsupported ${message.type} traffic.` }));
      }
    };

    yield* Effect.raceFirst(
      Effect.forever(Queue.take(inbound).pipe(Effect.map(decodeFrame), Effect.flatMap(handle))),
      Fiber.join(socketFiber),
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
      WorkflowTransitionError: (error: WorkflowTransitionError) =>
        Effect.fail(new BebopSessionError({ reason: `A Bebop command violated the workflow: ${error.error.type}.` })),
    }),
    Effect.scoped,
  );

export const runBebopClient = Effect.gen(function* () {
  const config = yield* SwordfishConfiguration;
  const identity = yield* SwordfishIdentity;
  const store = yield* SwordfishStore;
  let delay = Duration.toMillis(config.reconnectMinimumDelay);
  const maximum = Duration.toMillis(config.reconnectMaximumDelay);

  for (;;) {
    const outcome = yield* Effect.exit(
      session(Effect.sync(() => (delay = Duration.toMillis(config.reconnectMinimumDelay)))).pipe(
        Effect.provide(
          BunSocket.layerWebSocket(config.bebopWebSocketUrl.href, {
            protocols: `bebop-token.${Redacted.value(config.bebopToken)}`,
            openTimeout: config.reconnectMaximumDelay,
          }),
        ),
      ),
    );
    const disconnectedAt = yield* identity.now;
    yield* store
      .setConnected(false, disconnectedAt)
      .pipe(Effect.catchCause((cause) => Effect.logError("could not record Bebop disconnect", cause)));
    yield* Effect.logWarning("Bebop connection ended; reconnecting").pipe(
      Effect.annotateLogs("retry_delay_ms", String(delay)),
      Effect.annotateLogs("outcome", outcome._tag),
    );
    yield* Effect.sleep(Duration.millis(delay));
    delay = Math.min(maximum, delay * 2);
  }
});
