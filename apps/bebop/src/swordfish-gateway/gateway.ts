// The Swordfish connection gateway (SPEC section 18).
//
// Swordfish dials out; Bebop accepts. One WebSocket per bounty carries registration,
// heartbeats, sequenced events, acknowledgements, command delivery, and command results.
//
// Three rules run through everything below and are the reason the code is shaped this way:
//
// 1. **An acknowledgement is a promise that the event is durable.** Swordfish drops an
//    acknowledged event from its outbox permanently (SPEC section 18.3), so Bebop
//    acknowledges only after the projection transaction has committed, and never for an
//    input it discarded — `wrong_connection` is not an error, but acknowledging it would
//    lose the event for good.
// 2. **Identity is checked once and then enforced on every message.** The credential is
//    bound to one bounty and one VM; a later message claiming a different pair is a protocol
//    error, not a routing hint.
// 3. **A malformed or oversized frame fails closed.** The connection is refused rather than
//    buffered, which is the mechanism PLAN Milestone 5's "bounded queues and oversized or
//    malformed messages fail closed" scenario tests.

import type {
  BebopToSwordfishMessage,
  BountyId,
  ConnectionId,
  EventMessage,
  HeartbeatMessage,
  ProtocolErrorCode,
  RegisterMessage,
  SwordfishToBebopMessage,
  VmId,
} from "@bebop/contracts";
import {
  currentProtocolVersion,
  decodeSwordfishToBebopMessage,
  InvalidProtocolMessageError,
  UnsupportedProtocolVersionError,
} from "@bebop/contracts";
import { BebopToSwordfishMessage as BebopToSwordfishMessageSchema } from "@bebop/contracts";
import { Effect, Fiber, Queue, Result, Schedule, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpRouter } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { BebopConfiguration } from "#src/config.ts";
import { Identity } from "#src/domain/identity.ts";
import type { BebopSwordfishProjection } from "#src/domain/swordfish-projection.ts";
import { BountyRepository } from "#src/persistence/bounties.ts";
import { CommandRepository } from "#src/persistence/commands.ts";
import { applyProjectionInput } from "#src/service/projection.ts";
import { hashSwordfishToken, presentedSwordfishToken } from "#src/swordfish-gateway/credentials.ts";

/** The path Swordfish dials. Shares the API's port, as SPEC section 24 deploys one service. */
export const swordfishGatewayPath = "/swordfish";

const encodeOutbound = Schema.encodeUnknownSync(BebopToSwordfishMessageSchema);

/** How many queued commands one drain sends. Bounded so a long backlog cannot stall a turn. */
const commandBatchSize = 32;

/** Frames waiting for the one ordered protocol consumer. */
const inboundFrameCapacity = 64;

interface Session {
  readonly connectionId: ConnectionId;
  readonly bountyId: BountyId;
  readonly vmId: VmId;
}

export const SwordfishGatewayRoute = HttpRouter.use((router) =>
  router.add(
    "GET",
    swordfishGatewayPath,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const config = yield* BebopConfiguration;
      const identity = yield* Identity;
      const bounties = yield* BountyRepository;
      const commands = yield* CommandRepository;

      const presented = presentedSwordfishToken(request.headers);
      if (presented === null) {
        yield* Effect.logWarning("swordfish upgrade without a credential");
        return HttpServerResponse.empty({ status: 401 });
      }
      const authorizedIdentity = yield* bounties.swordfishIdentityForTokenHash(hashSwordfishToken(presented));
      if (authorizedIdentity === null) {
        yield* Effect.logWarning("swordfish upgrade with an unknown credential");
        return HttpServerResponse.empty({ status: 401 });
      }

      const socket = yield* request.upgrade;
      const write = yield* socket.writer;

      const send = (message: BebopToSwordfishMessage) => write(JSON.stringify(encodeOutbound(message)));

      const protocolError = (code: ProtocolErrorCode, message: string) =>
        send({ type: "protocol_error", protocolVersion: currentProtocolVersion, code, message });

      // Registration has not happened yet. Until it does, only a `register` message is
      // meaningful, which is what `session` being null encodes.
      let session: Session | null = null;

      /**
       * Sends every queued command Swordfish has not been given yet.
       *
       * Marking delivery *after* the write is deliberate: an unmarked command is redelivered
       * on the next drain, and `commandId` makes a duplicate delivery harmless, whereas a
       * command marked delivered but never written is lost.
       */
      const drainCommands = (current: Session) =>
        Effect.gen(function* () {
          const pending = yield* commands.pendingDelivery({ bountyId: current.bountyId, limit: commandBatchSize });
          for (const queued of pending) {
            const issuedAt = yield* identity.now;
            yield* send({
              type: "command",
              protocolVersion: currentProtocolVersion,
              bountyId: current.bountyId,
              vmId: current.vmId,
              commandId: queued.commandId,
              issuedAt: queued.issuedAt,
              command: queued.command,
            });
            yield* commands.markDelivered({ commandId: queued.commandId, at: issuedAt });
          }
        });

      const acknowledge = (current: Session, projection: BebopSwordfishProjection) =>
        send({
          type: "event_acknowledged",
          protocolVersion: currentProtocolVersion,
          bountyId: current.bountyId,
          vmId: current.vmId,
          acknowledgedThrough: projection.lastAppliedSequence,
        });

      const handleRegister = (message: RegisterMessage) =>
        Effect.gen(function* () {
          if (message.bountyId !== authorizedIdentity.bountyId || message.vmId !== authorizedIdentity.vmId) {
            // The credential names the bounty. A register claiming a different one is not a
            // routing mistake to be corrected — it is a credential being used for a bounty it
            // was not minted for.
            yield* protocolError("identity_mismatch", "The credential does not authorise this bounty and VM.");
            return;
          }
          const connectionId = yield* identity.connectionId;
          const observedAt = yield* identity.now;
          const current: Session = { connectionId, bountyId: message.bountyId, vmId: message.vmId };

          // Recorded before `registered` is written, not after. Swordfish sends its first
          // event the instant it sees that reply, and a session assigned afterwards leaves a
          // window in which that event arrives at a gateway that believes nothing has
          // registered — which it then answers with "register first".
          session = current;

          const applied = yield* applyProjectionInput({
            bountyId: current.bountyId,
            vmId: current.vmId,
            input: { type: "connection_registered", connectionId, observedAt },
            at: observedAt,
          });
          if (!applied.result.ok) {
            session = null;
            yield* protocolError("identity_mismatch", "The stored projection belongs to a different VM.");
            return;
          }

          yield* send({
            type: "registered",
            protocolVersion: currentProtocolVersion,
            connectionId,
            bountyId: current.bountyId,
            vmId: current.vmId,
            serverTime: observedAt,
            acknowledgedThrough: applied.projection.lastAppliedSequence,
          });
          yield* Effect.logInfo("swordfish registered").pipe(
            Effect.annotateLogs("bounty_id", current.bountyId),
            Effect.annotateLogs("vm_id", current.vmId),
            Effect.annotateLogs("connection_id", connectionId),
          );
          // A reconnect is exactly when an offline bounty's queued commands are owed
          // (SPEC section 18.4).
          yield* drainCommands(current);
        });

      const handleEvent = (current: Session, message: EventMessage) =>
        Effect.gen(function* () {
          const observedAt = yield* identity.now;
          const applied = yield* applyProjectionInput({
            bountyId: current.bountyId,
            vmId: current.vmId,
            input: { type: "event_received", connectionId: current.connectionId, message, observedAt },
            at: observedAt,
          });

          if (!applied.result.ok) {
            const error = applied.result.error;
            yield* protocolError(
              error.type === "sequence_gap" ? "sequence_gap" : "invalid_message",
              `The event at sequence ${message.sequence} was rejected: ${error.type}.`,
            );
            return;
          }
          // `already_applied` and `unverifiable_replay` are both behind the frontier and safe
          // to acknowledge; not acknowledging them loops replay forever. `wrong_connection`
          // is not, because Bebop discarded the event.
          if (applied.result.applied || applied.result.reason !== "wrong_connection") {
            yield* acknowledge(current, applied.projection);
          }
        });

      const handleHeartbeat = (current: Session, message: HeartbeatMessage) =>
        Effect.gen(function* () {
          const observedAt = yield* identity.now;
          yield* applyProjectionInput({
            bountyId: current.bountyId,
            vmId: current.vmId,
            input: { type: "heartbeat_observed", connectionId: current.connectionId, message, observedAt },
            at: observedAt,
          });
          // A heartbeat is also the moment to hand over anything queued while the socket was
          // idle, so a command does not wait for the poll interval.
          yield* drainCommands(current);
        });

      const handle = (message: SwordfishToBebopMessage) =>
        Effect.gen(function* () {
          if (message.type === "register") {
            return yield* handleRegister(message);
          }
          const current = session;
          if (current === null) {
            yield* protocolError("invalid_message", "Register before sending anything else.");
            return;
          }
          if (message.type === "protocol_error") {
            yield* Effect.logWarning("swordfish reported a protocol error").pipe(
              Effect.annotateLogs("bounty_id", current.bountyId),
              Effect.annotateLogs("code", message.code),
            );
            return;
          }
          if (message.bountyId !== current.bountyId || message.vmId !== current.vmId) {
            yield* protocolError("identity_mismatch", "This message names a different bounty or VM.");
            return;
          }
          switch (message.type) {
            case "event":
              return yield* handleEvent(current, message);
            case "heartbeat":
              return yield* handleHeartbeat(current, message);
            case "command_result": {
              const reportedAt = yield* identity.now;
              const recorded = yield* commands.recordResult({
                bountyId: current.bountyId,
                commandId: message.commandId,
                status: message.status,
                reportedAt,
                ...(message.error === undefined ? {} : { error: message.error }),
              });
              if (recorded === null) {
                return yield* protocolError("invalid_message", "The command does not belong to this bounty.");
              }
              return;
            }
            default:
              // Evidence upload negotiation lands with the blob store in Milestone 10.
              return yield* protocolError("invalid_message", `"${message.type}" is not accepted yet.`);
          }
        });

      // A queued command issued while this socket is quiet still has to arrive. The poll is
      // the floor; registration and heartbeats are the fast paths.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const current = session;
          if (current !== null) {
            yield* drainCommands(current);
          }
        }).pipe(
          Effect.catchCause((cause) => Effect.logError("swordfish command poll failed", cause)),
          Effect.repeat(Schedule.spaced(config.commandPollInterval)),
        ),
      );

      const processFrame = (frame: string) =>
        Effect.gen(function* () {
          if (frame.length > config.maxProtocolMessageBytes) {
            // Fail closed: refuse and close rather than buffering an unbounded message or
            // letting it reach the reducer.
            yield* protocolError("invalid_message", "The message exceeds the accepted size.");
            return yield* write(new Socket.CloseEvent(1009, "message too big"));
          }
          const decoded = yield* Effect.result(
            Effect.try({
              try: () => decodeSwordfishToBebopMessage(JSON.parse(frame) as unknown),
              catch: (cause: unknown) => cause,
            }),
          );
          if (Result.isFailure(decoded)) {
            const cause = decoded.failure;
            const code: ProtocolErrorCode =
              cause instanceof UnsupportedProtocolVersionError ? "unsupported_version" : "invalid_message";
            const message =
              cause instanceof UnsupportedProtocolVersionError || cause instanceof InvalidProtocolMessageError
                ? cause.message
                : "The message could not be decoded.";
            yield* protocolError(code, message);
            return yield* write(new Socket.CloseEvent(1008, "invalid protocol message"));
          }
          return yield* handle(decoded.success);
        });

      // Effect's Bun socket adapter dispatches each message handler in its own fiber. The
      // protocol is ordered, so handlers only enqueue here and one consumer performs every
      // stateful operation. `offerUnsafe` fails immediately rather than accumulating an
      // unbounded set of fibers blocked on a full queue.
      const inbound = yield* Queue.bounded<string>(inboundFrameCapacity);
      const consumer = yield* Effect.forkScoped(Effect.forever(Queue.take(inbound).pipe(Effect.flatMap(processFrame))));
      let overloaded = false;
      const recordDisconnect = Effect.suspend(() => {
        const current = session;
        if (current === null) {
          return Effect.void;
        }
        return Effect.gen(function* () {
          const detectedAt = yield* identity.now;
          yield* applyProjectionInput({
            bountyId: current.bountyId,
            vmId: current.vmId,
            input: { type: "connection_lost", connectionId: current.connectionId, detectedAt },
            at: detectedAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("could not record swordfish disconnect", cause).pipe(
              Effect.annotateLogs("bounty_id", current.bountyId),
              Effect.annotateLogs("connection_id", current.connectionId),
            ),
          ),
        );
      });
      yield* Effect.raceFirst(
        socket
          .runString((frame) =>
            Effect.gen(function* () {
              if (overloaded) {
                return;
              }
              if (!Queue.offerUnsafe(inbound, frame)) {
                overloaded = true;
                yield* protocolError("invalid_message", "The inbound message queue is full.");
                yield* write(new Socket.CloseEvent(1013, "inbound queue full"));
              }
            }),
          )
          .pipe(Effect.catchIf(Socket.isSocketError, (error) => Effect.logDebug("swordfish socket closed", error))),
        Fiber.join(consumer),
      ).pipe(Effect.ensuring(recordDisconnect));

      return HttpServerResponse.empty();
    }).pipe(Effect.scoped),
  ),
);
