import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { currentSfControlVersion, SfControlRequest } from "@bebop/contracts";
import { Effect, Fiber, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { requestControl, verifyControlSocket } from "#src/control/client.ts";
import { runControlSocket } from "#src/control/server.ts";
import { SwordfishIdentity } from "#src/domain/identity.ts";
import type { SwordfishHarness } from "#test/component/support/harness.ts";
import { startSwordfishHarness } from "#test/component/support/harness.ts";

let harness: SwordfishHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const stats = await lstat(path);
      if (stats.isSocket() && (stats.mode & 0o777) === 0o600) return;
    } catch {
      // The server has not bound yet.
    }
    await Bun.sleep(10);
  }
  throw new Error(`control socket ${path} did not become ready`);
}

describe("Swordfish local control", () => {
  test("serves status and stop over a mode-0600 Unix socket", async () => {
    harness = await startSwordfishHarness("control");
    const fiber = harness.fork(runControlSocket);
    try {
      await waitForSocket(harness.config.controlSocketPath);
      expect((await lstat(harness.config.controlSocketPath)).mode & 0o777).toBe(0o600);
      const request = await harness.run(
        Effect.gen(function* () {
          const identity = yield* SwordfishIdentity;
          return Schema.decodeUnknownSync(SfControlRequest)({
            type: "request",
            controlVersion: currentSfControlVersion,
            correlationId: yield* identity.correlationId,
            command: { type: "status" },
          });
        }),
      );
      const response = await Effect.runPromise(
        requestControl(harness.config.controlSocketPath, request).pipe(Effect.scoped),
      );
      expect(response.type).toBe("success");
      if (response.type === "success") {
        expect(response.result.snapshot.stage).toBe("interactive");
        expect(response.result.snapshot.bebopConnection.pendingEventCount).toBe(1);
      }

      const secondDaemon = await harness.run(Effect.exit(runControlSocket));
      expect(secondDaemon._tag).toBe("Failure");
      const stillServing = await Effect.runPromise(
        requestControl(harness.config.controlSocketPath, request).pipe(Effect.scoped),
      );
      expect(stillServing.type).toBe("success");

      const firstUse = Schema.decodeUnknownSync(SfControlRequest)({
        type: "request",
        controlVersion: currentSfControlVersion,
        correlationId: "sf-conflict",
        command: { type: "takeover", seat: "ein", force: false },
      });
      await Effect.runPromise(requestControl(harness.config.controlSocketPath, firstUse).pipe(Effect.scoped));
      const conflictingUse = Schema.decodeUnknownSync(SfControlRequest)({
        ...Schema.encodeUnknownSync(SfControlRequest)(firstUse),
        command: { type: "stop" },
      });
      const conflict = await Effect.runPromise(
        requestControl(harness.config.controlSocketPath, conflictingUse).pipe(Effect.scoped),
      );
      expect(conflict.type).toBe("error");
      if (conflict.type === "error") expect(conflict.error.code).toBe("correlation_conflict");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("refuses absent, non-socket, and over-permissive socket paths", async () => {
    harness = await startSwordfishHarness("permissions");
    const absent = join(harness.root, "absent.sock");
    expect((await Effect.runPromise(Effect.exit(verifyControlSocket(absent))))._tag).toBe("Failure");

    const regular = join(harness.root, "regular.sock");
    await writeFile(regular, "not a socket");
    await chmod(regular, 0o600);
    expect((await Effect.runPromise(Effect.exit(verifyControlSocket(regular))))._tag).toBe("Failure");

    const unsafe = join(harness.root, "unsafe", "control.sock");
    await mkdir(join(harness.root, "unsafe"));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(unsafe, resolve));
    try {
      await chmod(unsafe, 0o666);
      expect((await Effect.runPromise(Effect.exit(verifyControlSocket(unsafe))))._tag).toBe("Failure");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(unsafe, { force: true });
    }
  });

  test("rejects a malformed daemon response", async () => {
    harness = await startSwordfishHarness("malformed-response");
    const path = join(harness.root, "malformed.sock");
    const server = createServer((connection) => {
      connection.once("data", () => connection.end('{"type":"success"}\n'));
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await chmod(path, 0o600);
    try {
      const request = Schema.decodeUnknownSync(SfControlRequest)({
        type: "request",
        controlVersion: currentSfControlVersion,
        correlationId: "sf-malformed",
        command: { type: "status" },
      });
      const exit = await Effect.runPromise(Effect.exit(requestControl(path, request).pipe(Effect.scoped)));
      expect(exit._tag).toBe("Failure");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(path, { force: true });
    }
  });
});
