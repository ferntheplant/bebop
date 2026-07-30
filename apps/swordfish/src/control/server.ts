import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";

import type {
  BebopCommand,
  CommandId,
  SfControlErrorCode,
  SfControlRequest,
  SfControlResponse,
} from "@bebop/contracts";
import {
  CommandId as CommandIdSchema,
  currentSfControlVersion,
  decodeSfControlRequest,
  InvalidSfControlRequestError,
  SfControlResponse as SfControlResponseSchema,
  UnsupportedSfControlVersionError,
} from "@bebop/contracts";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { Data, Deferred, Duration, Effect, Fiber, Schema } from "effect";
import { Socket, SocketServer } from "effect/unstable/socket";

import { SwordfishConfiguration } from "#src/config.ts";
import { ShutdownSignal } from "#src/daemon/shutdown.ts";
import { SwordfishIdentity } from "#src/domain/identity.ts";
import { WorkflowService } from "#src/workflow/service.ts";
import { commandMessage } from "#src/workflow/service.ts";

const maxControlFrameLength = 262_144;

export class ControlSocketSetupError extends Data.TaggedError("ControlSocketSetupError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not use Swordfish control socket ${this.path}.`;
  }
}

function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const connection = createConnection({ path });
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", (cause: NodeJS.ErrnoException) => {
      connection.destroy();
      if (cause.code === "ECONNREFUSED" || cause.code === "ENOENT") resolve(false);
      else reject(cause);
    });
  });
}

export const prepareControlSocket = Effect.fnUntraced(function* (path: string) {
  const parent = dirname(path);
  yield* Effect.tryPromise({
    try: () => mkdir(parent, { recursive: true, mode: 0o700 }),
    catch: (cause) => new ControlSocketSetupError({ path, cause }),
  });
  const parentStats = yield* Effect.tryPromise({
    try: () => lstat(parent),
    catch: (cause) => new ControlSocketSetupError({ path: parent, cause }),
  });
  const uid = process.getuid?.();
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || (uid !== undefined && parentStats.uid !== uid)) {
    return yield* Effect.fail(
      new ControlSocketSetupError({ path: parent, cause: new Error("Unsafe control socket directory") }),
    );
  }
  yield* Effect.tryPromise({
    try: () => chmod(parent, 0o700),
    catch: (cause) => new ControlSocketSetupError({ path: parent, cause }),
  });
  const existing = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await lstat(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
    },
    catch: (cause) => new ControlSocketSetupError({ path, cause }),
  });
  if (existing === null) return;
  if (!existing.isSocket()) {
    return yield* Effect.fail(new ControlSocketSetupError({ path, cause: new Error("Path is not a Unix socket") }));
  }
  const active = yield* Effect.tryPromise({
    try: () => socketAcceptsConnections(path),
    catch: (cause) => new ControlSocketSetupError({ path, cause }),
  });
  if (active) {
    return yield* Effect.fail(new ControlSocketSetupError({ path, cause: new Error("Swordfish is already running") }));
  }
  yield* Effect.tryPromise({
    try: () => rm(path),
    catch: (cause) => new ControlSocketSetupError({ path, cause }),
  });
});

function localCommandId(request: SfControlRequest): CommandId {
  const digest = createHash("sha256").update(request.correlationId).digest("hex").slice(0, 32);
  return Schema.decodeUnknownSync(CommandIdSchema)(`local-${digest}`);
}

function responseError(request: SfControlRequest, code: SfControlErrorCode, message: string): SfControlResponse {
  return {
    type: "error",
    controlVersion: currentSfControlVersion,
    correlationId: request.correlationId,
    error: { code, message },
  };
}

const handleRequest = Effect.fnUntraced(function* (request: SfControlRequest) {
  const config = yield* SwordfishConfiguration;
  const identity = yield* SwordfishIdentity;
  const workflow = yield* WorkflowService;

  if (request.command.type === "status") {
    return {
      response: {
        type: "success",
        controlVersion: currentSfControlVersion,
        correlationId: request.correlationId,
        result: { command: request.command, snapshot: yield* workflow.status },
      } satisfies SfControlResponse,
      stop: false,
    };
  }

  let command: BebopCommand;
  switch (request.command.type) {
    case "handback": {
      const status = yield* workflow.status;
      const seat = status.seats.find((entry) => entry.leaseOwner === "human");
      if (seat === undefined) {
        return { response: responseError(request, "lease_not_held", "No seat is held by a human."), stop: false };
      }
      command = { type: "handback", seat: seat.role };
      break;
    }
    case "approve_config":
      return {
        response: responseError(request, "config_approval_not_pending", "No configuration approval is pending."),
        stop: false,
      };
    default:
      command = request.command;
  }

  const issuedAt = yield* identity.now;
  const result = yield* workflow.applyCommand(
    commandMessage({ commandId: localCommandId(request), command, issuedAt, config }),
  );
  if (result.status === "rejected" || result.status === "failed") {
    const code: SfControlErrorCode =
      command.type === "takeover"
        ? "seat_unavailable"
        : command.type === "extend_constraint"
          ? "constraint_extension_not_allowed"
          : command.type === "retry_stage"
            ? "stage_retry_not_allowed"
            : "invalid_state";
    return { response: responseError(request, code, result.error ?? "The command was rejected."), stop: false };
  }

  return {
    response: {
      type: "success",
      controlVersion: currentSfControlVersion,
      correlationId: request.correlationId,
      result: { command: request.command, snapshot: yield* workflow.status },
    } satisfies SfControlResponse,
    stop: command.type === "stop",
  };
});

const connectionHandler = Effect.fnUntraced(function* (socket: Socket.Socket) {
  const identity = yield* SwordfishIdentity;
  const shutdown = yield* ShutdownSignal;
  const writer = yield* socket.writer;
  const requestFrame = yield* Deferred.make<string, ControlSocketSetupError>();
  let buffer = "";

  const reader = yield* Effect.forkScoped(
    socket.runString((chunk) => {
      buffer += chunk;
      if (new TextEncoder().encode(buffer).byteLength > maxControlFrameLength) {
        return Deferred.fail(
          requestFrame,
          new ControlSocketSetupError({ path: "control request", cause: new Error("Request is too large") }),
        ).pipe(Effect.asVoid);
      }
      const newline = buffer.indexOf("\n");
      return newline < 0 ? Effect.void : Deferred.succeed(requestFrame, buffer.slice(0, newline)).pipe(Effect.asVoid);
    }),
  );

  const readerEnded = Fiber.join(reader).pipe(
    Effect.andThen(
      Effect.fail(
        new ControlSocketSetupError({
          path: "control request",
          cause: new Error("Client closed before sending a complete request"),
        }),
      ),
    ),
  );
  const frame = yield* Effect.raceFirst(Deferred.await(requestFrame), readerEnded).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () =>
        Effect.fail(new ControlSocketSetupError({ path: "control request", cause: new Error("Request timed out") })),
    }),
  );
  const decoded = yield* Effect.result(
    Effect.try({
      try: () => decodeSfControlRequest(JSON.parse(frame) as unknown),
      catch: (cause) => cause,
    }),
  );

  let response: SfControlResponse;
  let stop = false;
  if (decoded._tag === "Failure") {
    const correlationId = yield* identity.correlationId;
    const cause = decoded.failure;
    response = {
      type: "error",
      controlVersion: currentSfControlVersion,
      correlationId,
      error: {
        code: cause instanceof UnsupportedSfControlVersionError ? "unsupported_version" : "invalid_request",
        message:
          cause instanceof UnsupportedSfControlVersionError || cause instanceof InvalidSfControlRequestError
            ? cause.message
            : "The control request could not be decoded.",
      },
    };
  } else {
    const handled = yield* handleRequest(decoded.success).pipe(
      Effect.catchTag("CommandConflictError", () =>
        Effect.succeed({
          response: responseError(
            decoded.success,
            "correlation_conflict",
            "This correlation id was already used for another command.",
          ),
          stop: false,
        }),
      ),
    );
    response = handled.response;
    stop = handled.stop;
  }

  yield* writer(`${JSON.stringify(Schema.encodeUnknownSync(SfControlResponseSchema)(response))}\n`);
  yield* writer(new Socket.CloseEvent(1000, "response complete"));
  yield* Fiber.interrupt(reader);
  if (stop) yield* shutdown.request;
});

export const runControlServer = Effect.gen(function* () {
  const config = yield* SwordfishConfiguration;
  const server = yield* SocketServer.SocketServer;
  yield* Effect.logInfo("Swordfish control socket listening").pipe(
    Effect.annotateLogs("control_socket", config.controlSocketPath),
  );
  return yield* server.run((socket) => connectionHandler(socket).pipe(Effect.scoped));
});

export const makeControlSocket = Effect.gen(function* () {
  const config = yield* SwordfishConfiguration;
  yield* prepareControlSocket(config.controlSocketPath);
  const server = yield* BunSocketServer.make({ path: config.controlSocketPath });
  yield* Effect.tryPromise({
    try: () => chmod(config.controlSocketPath, 0o600),
    catch: (cause) => new ControlSocketSetupError({ path: config.controlSocketPath, cause }),
  });
  return server;
});

export const runControlSocket = Effect.gen(function* () {
  const server = yield* makeControlSocket;
  return yield* runControlServer.pipe(Effect.provideService(SocketServer.SocketServer, server));
}).pipe(Effect.scoped);
