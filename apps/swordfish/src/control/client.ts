import { lstat } from "node:fs/promises";

import type { SfControlRequest, SfControlResponse } from "@bebop/contracts";
import { decodeSfControlResponseForRequest, SfControlRequest as SfControlRequestSchema } from "@bebop/contracts";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Data, Deferred, Duration, Effect, Fiber, Schema } from "effect";

const maxControlFrameLength = 262_144;

class UnsafeControlSocketError extends Data.TaggedError("UnsafeControlSocketError")<{
  readonly path: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.reason} (${this.path})`;
  }
}

class ControlSocketUnavailableError extends Data.TaggedError("ControlSocketUnavailableError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Swordfish daemon is unavailable at ${this.path}.`;
  }
}

class ControlTransportError extends Data.TaggedError("ControlTransportError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

export const verifyControlSocket = Effect.fnUntraced(function* (path: string) {
  const stats = yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => new ControlSocketUnavailableError({ path, cause }),
  });
  if (!stats.isSocket()) {
    return yield* Effect.fail(new UnsafeControlSocketError({ path, reason: "The path is not a Unix socket." }));
  }
  if ((stats.mode & 0o777) !== 0o600) {
    return yield* Effect.fail(new UnsafeControlSocketError({ path, reason: "The Unix socket must have mode 0600." }));
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    return yield* Effect.fail(
      new UnsafeControlSocketError({ path, reason: "The Unix socket is owned by another user." }),
    );
  }
});

export const requestControl = Effect.fnUntraced(function* (path: string, request: SfControlRequest) {
  yield* verifyControlSocket(path);
  const socket = yield* BunSocket.makeNet({ path, openTimeout: Duration.seconds(2) });
  const writer = yield* socket.writer;
  const response = yield* Deferred.make<string, ControlTransportError>();
  let buffer = "";

  const reader = yield* Effect.forkScoped(
    socket.runString((chunk) => {
      buffer += chunk;
      if (new TextEncoder().encode(buffer).byteLength > maxControlFrameLength) {
        return Deferred.fail(
          response,
          new ControlTransportError({ reason: "The daemon response exceeds the control protocol limit." }),
        ).pipe(Effect.asVoid);
      }
      const newline = buffer.indexOf("\n");
      return newline < 0 ? Effect.void : Deferred.succeed(response, buffer.slice(0, newline)).pipe(Effect.asVoid);
    }),
  );

  yield* writer(`${JSON.stringify(Schema.encodeUnknownSync(SfControlRequestSchema)(request))}\n`);
  const readerEnded = Fiber.join(reader).pipe(
    Effect.andThen(
      Effect.fail(new ControlTransportError({ reason: "The daemon closed before returning a complete response." })),
    ),
    Effect.catchCause((cause) =>
      Effect.fail(new ControlTransportError({ reason: "The daemon connection failed before a response.", cause })),
    ),
  );
  const frame = yield* Effect.raceFirst(Deferred.await(response), readerEnded).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () => Effect.fail(new ControlTransportError({ reason: "Timed out waiting for the Swordfish daemon." })),
    }),
  );
  yield* Fiber.interrupt(reader);

  return yield* Effect.try({
    try: (): SfControlResponse => decodeSfControlResponseForRequest(JSON.parse(frame) as unknown, request),
    catch: (cause) => new ControlTransportError({ reason: "The daemon returned an invalid control response.", cause }),
  });
});
