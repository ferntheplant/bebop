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

function controlRequest(
  correlationId: string,
  command: SfControlCommand,
  operatorCredential?: string,
): SfControlRequest {
  return Schema.decodeUnknownSync(SfControlRequest)({
    type: "request",
    controlVersion: currentSfControlVersion,
    correlationId,
    command,
    ...(operatorCredential === undefined ? {} : { operatorCredential }),
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
  test("serves status and cancellation over a mode-0600 Unix socket", async () => {
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
        operatorCredential: harness.operatorCredential,
      });
      await Effect.runPromise(requestControl(harness.config.controlSocketPath, firstUse).pipe(Effect.scoped));
      const conflictingUse = Schema.decodeUnknownSync(SfControlRequest)({
        ...Schema.encodeUnknownSync(SfControlRequest)(firstUse),
        command: { type: "cancel" },
      });
      const conflict = await Effect.runPromise(
        requestControl(harness.config.controlSocketPath, conflictingUse).pipe(Effect.scoped),
      );
      expect(conflict.type).toBe("error");
      if (conflict.type === "error") expect(conflict.error.code).toBe("correlation_conflict");

      const cancelled = await Effect.runPromise(
        requestControl(
          harness.config.controlSocketPath,
          controlRequest("sf-cancel", { type: "cancel" }, harness.operatorCredential),
        ).pipe(Effect.scoped),
      );
      expect(cancelled.type).toBe("success");
      if (cancelled.type === "success") expect(cancelled.result.snapshot.stage).toBe("cancelled");
      const afterCancellation = await Effect.runPromise(
        requestControl(harness.config.controlSocketPath, controlRequest("sf-after-cancel", { type: "status" })).pipe(
          Effect.scoped,
        ),
      );
      expect(afterCancellation.type).toBe("success");
      if (afterCancellation.type === "success") expect(afterCancellation.result.snapshot.stage).toBe("cancelled");
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
        (encoded["result"] as Record<string, unknown>)["command"] = { type: "cancel" };
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
        requestControl(
          harness.config.controlSocketPath,
          controlRequest("sf-internal", { type: "cancel" }, harness.operatorCredential),
        ).pipe(Effect.scoped),
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

  test("takeover clears the attention that advertised it as the exit", async () => {
    harness = await startSwordfishHarness("takeover-clears-attention");
    await harness.run(
      Effect.flatMap(WorkflowService, (workflow) =>
        Effect.gen(function* () {
          yield* workflow.append(
            Schema.decodeUnknownSync(SwordfishEvent)({ type: "cowboy_activated", seat: "ein", seatId: "seat-ein" }),
          );
          yield* workflow.append(
            Schema.decodeUnknownSync(SwordfishEvent)({
              type: "attention_required",
              kind: "intrusion",
              reason: "Unexpected shell execution in the ein seat.",
            }),
          );
        }),
      ),
    );

    const before = await harness.run(Effect.flatMap(WorkflowService, (workflow) => workflow.status));
    expect(before.stage).toBe("needs_attention");
    expect(before.attention[0]?.resolutions).toContain("takeover ein");

    const fiber = harness.fork(runControlSocket);
    try {
      await waitForSocket(harness.config.controlSocketPath);
      const socketPath = harness.config.controlSocketPath;
      const response = await Effect.runPromise(
        requestControl(
          socketPath,
          controlRequest(
            "sf-cmd-takeover-attention",
            { type: "takeover", seat: "ein", force: false },
            harness.operatorCredential,
          ),
        ).pipe(Effect.scoped),
      );

      expect(response.type).toBe("success");
      if (response.type === "success") {
        // Status must stop advertising an exit that a second attempt would now reject for control already
        // being held (`docs/capabilities/05-control-lease-and-takeover.md`).
        const snapshot = response.result.snapshot;
        expect(snapshot.controller).toBe("human");
        expect(snapshot.attention).toEqual([]);
        expect(snapshot.stage).toBe("interactive");
      }
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("drives takeover, handoff, and recovery commands over the socket", async () => {
    harness = await startSwordfishHarness("commands");
    // There has to be an active cowboy to take over from ("One controller drives one active cowboy" (ADR 0037)).
    await harness.run(
      Effect.flatMap(WorkflowService, (workflow) =>
        workflow.append(
          Schema.decodeUnknownSync(SwordfishEvent)({
            type: "cowboy_activated",
            seat: "ein",
            seatId: "seat-ein",
          }),
        ),
      ),
    );
    const fiber = harness.fork(runControlSocket);
    try {
      await waitForSocket(harness.config.controlSocketPath);
      const socketPath = harness.config.controlSocketPath;
      const operatorCredential = harness.operatorCredential;
      const send = (correlationId: string, command: SfControlCommand): Promise<SfControlResponse> =>
        Effect.runPromise(
          requestControl(socketPath, controlRequest(correlationId, command, operatorCredential)).pipe(Effect.scoped),
        );

      const takeover = await send("sf-cmd-takeover", { type: "takeover", seat: "ein", force: false });
      expect(takeover.type).toBe("success");
      if (takeover.type === "success") {
        // Takeover changes who is driving, not what is being driven.
        expect(takeover.result.snapshot.stage).toBe("interactive");
        expect(takeover.result.snapshot.controller).toBe("human");
        expect(takeover.result.snapshot.activeCowboy).toMatchObject({ role: "ein", seatId: "seat-ein" });
      }

      const handoff = await send("sf-cmd-handoff", { type: "handoff" });
      expect(handoff.type).toBe("success");
      if (handoff.type === "success") {
        expect(handoff.result.snapshot.stage).toBe("interactive");
        expect(handoff.result.snapshot.controller).toBe("swordfish");
      }

      // Every recovery verb is refused with nothing outstanding to recover from. That is the whole admissibility
      // rule: a grant answers an attention record, so with no record there is nothing to grant against and
      // `continue` cannot be used to hand an attempt more budget than the profile allows.
      for (const command of [
        { type: "continue" },
        { type: "rerun", target: "building" },
        { type: "resume" },
      ] as const) {
        const refused = await send(`sf-cmd-${command.type}-${"target" in command ? command.target : "none"}`, command);
        expect(refused.type).toBe("error");
        if (refused.type === "error") expect(refused.error.code).toBe("recovery_not_available");
      }

      const status = await send("sf-cmd-ledger", { type: "status" });
      expect(status.type).toBe("success");
      if (status.type === "success") {
        // The ledger is served from the workflow state, so a bounty that has run no attempts reports a full
        // allowance for every scope rather than rows from a table nobody wrote to.
        expect(status.result.snapshot.constraints).toEqual([
          { scope: "building", attempts: { consumed: 0, base: 3, granted: 0 } },
          { scope: "review", attempts: { consumed: 0, base: 2, granted: 0 } },
          { scope: "qa", attempts: { consumed: 0, base: 2, granted: 0 } },
        ]);
        expect(status.result.snapshot.validatedCandidates).toEqual({ consumed: 0, base: 3, granted: 0 });
        expect(status.result.snapshot.exhausted).toEqual([]);
      }
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("requires the operator credential for mutating commands and not for status", async () => {
    harness = await startSwordfishHarness("operator-auth");
    const fiber = harness.fork(runControlSocket);
    try {
      await waitForSocket(harness.config.controlSocketPath);
      const socketPath = harness.config.controlSocketPath;

      // Status is read-only and stays unprompted (ADR 0038).
      const status = await Effect.runPromise(
        requestControl(socketPath, controlRequest("sf-auth-status", { type: "status" })).pipe(Effect.scoped),
      );
      expect(status.type).toBe("success");

      // A mutating command without the credential is refused.
      const missing = await Effect.runPromise(
        requestControl(socketPath, controlRequest("sf-auth-missing", { type: "cancel" })).pipe(Effect.scoped),
      );
      expect(missing.type).toBe("error");
      if (missing.type === "error") expect(missing.error.code).toBe("unauthorized");

      // A wrong credential is refused.
      const wrong = await Effect.runPromise(
        requestControl(socketPath, controlRequest("sf-auth-wrong", { type: "cancel" }, "bebop_op_wrong")).pipe(
          Effect.scoped,
        ),
      );
      expect(wrong.type).toBe("error");
      if (wrong.type === "error") expect(wrong.error.code).toBe("unauthorized");

      // The right credential is accepted.
      const accepted = await Effect.runPromise(
        requestControl(socketPath, controlRequest("sf-auth-ok", { type: "cancel" }, harness.operatorCredential)).pipe(
          Effect.scoped,
        ),
      );
      expect(accepted.type).toBe("success");
      if (accepted.type === "success") expect(accepted.result.snapshot.stage).toBe("cancelled");
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
