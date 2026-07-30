import { chmod, link, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";

import type { SfControlCommand, SfControlResponse } from "@bebop/contracts";
import {
  currentSfControlVersion,
  SfControlRequest,
  SfControlResponse as SfControlResponseSchema,
  SwordfishEvent,
} from "@bebop/contracts";
import { Effect, Fiber, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { requestControl, verifyControlSocket } from "#src/control/client.ts";
import { runControlSocket } from "#src/control/server.ts";
import { SwordfishIdentity } from "#src/domain/identity.ts";
import { WorkflowService, WorkflowTransitionError } from "#src/workflow/service.ts";
import type { SwordfishHarness } from "#test/component/support/harness.ts";
import { startSwordfishHarness } from "#test/component/support/harness.ts";

let harness: SwordfishHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function controlRequest(correlationId: string, command: SfControlCommand): SfControlRequest {
  return Schema.decodeUnknownSync(SfControlRequest)({
    type: "request",
    controlVersion: currentSfControlVersion,
    correlationId,
    command,
  });
}

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

  test("rejects valid daemon responses that do not match the request", async () => {
    harness = await startSwordfishHarness("mismatched-response");
    const fiber = harness.fork(runControlSocket);
    try {
      await waitForSocket(harness.config.controlSocketPath);
      const baseline = await Effect.runPromise(
        requestControl(harness.config.controlSocketPath, controlRequest("sf-baseline", { type: "status" })).pipe(
          Effect.scoped,
        ),
      );
      expect(baseline.type).toBe("success");

      const root = harness.root;
      const serveOnce = async (mutate: (encoded: Record<string, unknown>) => void) => {
        const path = join(root, `mismatch-${Math.random().toString(36).slice(2)}.sock`);
        const server = createServer((connection) => {
          connection.once("data", () => {
            const encoded = Schema.encodeUnknownSync(SfControlResponseSchema)(baseline) as Record<string, unknown>;
            mutate(encoded);
            connection.end(`${JSON.stringify(encoded)}\n`);
          });
        });
        await new Promise<void>((resolve) => server.listen(path, resolve));
        await chmod(path, 0o600);
        try {
          const exit = await Effect.runPromise(
            Effect.exit(requestControl(path, controlRequest("sf-baseline", { type: "status" })).pipe(Effect.scoped)),
          );
          expect(exit._tag).toBe("Failure");
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(path, { force: true });
        }
      };

      // A schema-valid success response under another correlation id.
      await serveOnce((encoded) => {
        encoded["correlationId"] = "sf-someone-else";
      });
      // A schema-valid success response answering a different command than requested.
      await serveOnce((encoded) => {
        (encoded["result"] as Record<string, unknown>)["command"] = { type: "stop" };
      });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("answers internal workflow failures with a correlated internal_error response", async () => {
    harness = await startSwordfishHarness("internal-error");
    const real = await harness.run(WorkflowService);
    const fiber = harness.fork(
      runControlSocket.pipe(
        Effect.provideService(WorkflowService, {
          ...real,
          applyCommand: () =>
            Effect.fail(
              new WorkflowTransitionError({
                error: { type: "illegal_transition", stage: "interactive", eventType: "test" },
              }),
            ),
        }),
      ),
    );
    try {
      await waitForSocket(harness.config.controlSocketPath);
      const response = await Effect.runPromise(
        requestControl(harness.config.controlSocketPath, controlRequest("sf-internal", { type: "stop" })).pipe(
          Effect.scoped,
        ),
      );
      expect(response.type).toBe("error");
      if (response.type === "error") {
        expect(response.correlationId).toBe("sf-internal");
        expect(response.error.code).toBe("internal_error");
      }
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("drives takeover, handback, extend, retry, and approve-config over the socket", async () => {
    harness = await startSwordfishHarness("commands");
    // A seat can only be taken over once Swordfish holds its lease.
    await harness.run(
      Effect.flatMap(WorkflowService, (workflow) =>
        workflow.append(
          Schema.decodeUnknownSync(SwordfishEvent)({
            type: "lease_changed",
            seat: "ein",
            seatId: "seat-ein",
            owner: "swordfish",
          }),
        ),
      ),
    );
    const fiber = harness.fork(runControlSocket);
    try {
      await waitForSocket(harness.config.controlSocketPath);
      const socketPath = harness.config.controlSocketPath;
      const send = (correlationId: string, command: SfControlCommand): Promise<SfControlResponse> =>
        Effect.runPromise(requestControl(socketPath, controlRequest(correlationId, command)).pipe(Effect.scoped));

      const takeover = await send("sf-cmd-takeover", { type: "takeover", seat: "ein", force: false });
      expect(takeover.type).toBe("success");
      if (takeover.type === "success") {
        expect(takeover.result.snapshot.stage).toBe("human_controlled");
        expect(takeover.result.snapshot.seats.find((seat) => seat.role === "ein")?.leaseOwner).toBe("human");
      }

      const handback = await send("sf-cmd-handback", { type: "handback" });
      expect(handback.type).toBe("success");
      if (handback.type === "success") {
        expect(handback.result.snapshot.stage).toBe("interactive");
        expect(handback.result.snapshot.seats.find((seat) => seat.role === "ein")?.leaseOwner).toBe("swordfish");
      }

      const extend = await send("sf-cmd-extend", { type: "extend_constraint", constraint: "primary_turns" });
      expect(extend.type).toBe("success");
      if (extend.type === "success") {
        expect(
          extend.result.snapshot.constraints.find((entry) => entry.constraint === "primary_turns")?.extensionsGranted,
        ).toBe(1);
      }

      const extended = await send("sf-cmd-extend-again", { type: "extend_constraint", constraint: "primary_turns" });
      expect(extended.type).toBe("error");
      if (extended.type === "error") expect(extended.error.code).toBe("constraint_extension_not_allowed");

      const retry = await send("sf-cmd-retry", { type: "retry_stage", stage: "local_validation" });
      expect(retry.type).toBe("error");
      if (retry.type === "error") expect(retry.error.code).toBe("stage_retry_not_allowed");

      const approve = await send("sf-cmd-approve", { type: "approve_config" });
      expect(approve.type).toBe("error");
      if (approve.type === "error") expect(approve.error.code).toBe("config_approval_not_pending");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("refuses aliased paths to the same SQLite authority", async () => {
    harness = await startSwordfishHarness("authority-owner");
    const fiber = harness.fork(runControlSocket);
    try {
      await waitForSocket(harness.config.controlSocketPath);
      const databaseAlias = join(harness.root, "state-alias");
      await symlink(dirname(harness.config.databasePath), databaseAlias, "dir");
      await expect(
        startSwordfishHarness("authority-competitor", {
          databasePath: join(databaseAlias, basename(harness.config.databasePath)),
        }),
      ).rejects.toThrow("Could not use Swordfish control socket");
      // The competing startup cannot disturb the owner or its control listener.
      const response = await Effect.runPromise(
        requestControl(harness.config.controlSocketPath, controlRequest("sf-owner", { type: "status" })).pipe(
          Effect.scoped,
        ),
      );
      expect(response.type).toBe("success");

      const caseAlias = join(dirname(harness.config.databasePath), basename(harness.config.databasePath).toUpperCase());
      const [databaseStats, caseAliasStats] = await Promise.all([
        lstat(harness.config.databasePath),
        lstat(caseAlias).catch(() => null),
      ]);
      if (caseAliasStats?.dev === databaseStats.dev && caseAliasStats.ino === databaseStats.ino) {
        await expect(startSwordfishHarness("authority-case-competitor", { databasePath: caseAlias })).rejects.toThrow(
          "Could not use Swordfish control socket",
        );
      }

      const databaseHardLink = join(harness.root, "state-hardlink.sqlite");
      await link(harness.config.databasePath, databaseHardLink);
      await expect(
        startSwordfishHarness("authority-hardlink-competitor", { databasePath: databaseHardLink }),
      ).rejects.toThrow("Could not use Swordfish control socket");
      await rm(databaseHardLink);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });
});
