// Every deployable program starts as a process, and says something useful when it cannot.
//
// This is the layer that catches a whole class of mistake nothing else does: a missing
// platform layer, a top-level import that only resolves under one runtime, a service that is
// never provided. `prototypes/effect-runtime` finding 4 is the archetype — without `BunStdio`,
// every CLI invocation fails at startup including `--help`, and only running the binary
// notices.

import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  adminDatabaseUrl,
  createDisposableDatabase,
  requestSwordfishStatus,
  waitForSwordfishControl,
} from "@bebop/testkit";
import { describe, expect, test } from "vite-plus/test";

interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** Set when `timeoutMs` elapsed and the process had to be killed, rather than exiting itself. */
  readonly killed: boolean;
}

interface RunningProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

/** Runs an entrypoint to completion, or kills it after `timeoutMs` and reports what it said. */
function run(
  entrypoint: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly env?: Readonly<Record<string, string>>;
    readonly unsetEnv?: ReadonlyArray<string>;
    readonly timeoutMs?: number;
    /** Written to the child's stdin and closed, so a mutating `sf` command can be driven noninteractively. */
    readonly stdin?: string;
  },
): Promise<Outcome> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...options?.env };
    for (const name of options?.unsetEnv ?? []) {
      delete env[name];
    }
    const child = spawn("bun", [entrypoint, ...args], {
      env,
      stdio: options?.stdin === undefined ? (["ignore", "pipe", "pipe"] as const) : (["pipe", "pipe", "pipe"] as const),
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout !== null) child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    if (child.stderr !== null) child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    if (options?.stdin !== undefined && child.stdin !== null) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, options?.timeoutMs ?? 10_000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, killed });
    });
  });
}

function startProcess(entrypoint: string, env: Readonly<Record<string, string>>): RunningProcess {
  const child = spawn("bun", [entrypoint], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  return {
    child,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`process did not stop after SIGTERM:\n${output}`));
        }, 15_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a test port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * Waits for the daemon to answer, then reads its status through the packed CLI.
 *
 * The wait and the read are deliberately different mechanisms. Waiting spawns nothing:
 * `waitForSwordfishControl` probes over the socket in this process, so what it measures is the
 * daemon rather than how quickly a loaded runner can cold-start `bun`. Reading then runs the
 * packed `cli.mjs` as a real process, on the default timeout, because proving the entrypoint
 * works as a process is what this file is for — it just must not be the stopwatch that decides
 * whether the daemon is up.
 */
async function waitForControlStatus(path: string, daemon: RunningProcess): Promise<Outcome> {
  await waitForSwordfishControl({
    path,
    timeoutMillis: 30_000,
    isRunning: () => daemon.child.exitCode === null && daemon.child.signalCode === null,
    describeDaemon: () => `Daemon output:\n${daemon.output()}`,
  });
  const outcome = await run("apps/swordfish/dist/cli.mjs", ["status", "--socket", path, "--json"]);
  if (outcome.exitCode !== 0) {
    throw new Error(
      `The daemon answered the control probe but the packed sf status exited ${outcome.exitCode}:\n${outcome.stderr}${daemon.output()}`,
    );
  }
  return outcome;
}

// 30s rather than 10s: a passing run never waits longer, but `vp run ready` fans five tasks out
// at once and an oversubscribed runner stretches every step under observation here.
async function waitForCondition(condition: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function waitForProcessExit(process: RunningProcess): Promise<number | null> {
  if (process.child.exitCode !== null) return Promise.resolve(process.child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit:\n${process.output()}`)), 30_000);
    process.child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForResponse(
  url: string,
  init?: RequestInit,
  accept: (response: Response) => boolean = (response) => response.status < 500,
): Promise<Response> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (accept(response)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process did not become ready: ${String(lastError)}`);
}

/**
 * A configuration good enough to get past `loadBebopConfig`, pointing at a database that is
 * not there.
 *
 * That is the point: it separates "the process could not read its configuration" from "the
 * process started and could not reach Postgres", and both must be reported rather than
 * hanging.
 */
const configuredWithNoDatabase = {
  BEBOP_HOST: "127.0.0.1",
  BEBOP_PORT: "0",
  BEBOP_DATABASE_URL: "postgres://bebop:bebop@127.0.0.1:1/bebop",
  BEBOP_PUBLIC_BASE_URL: "https://bebop.test.invalid/",
  BEBOP_ARTIFACT_ROOT: "/tmp/bebop-entrypoint-test",
  BEBOP_HEARTBEAT_INTERVAL: "5 seconds",
  BEBOP_SWORDFISH_STALE_AFTER: "20 seconds",
  BEBOP_MAX_PROTOCOL_MESSAGE_BYTES: "262144",
  BEBOP_SHUTDOWN_TIMEOUT: "2 seconds",
  BEBOP_SWORDFISH_CREDENTIAL_KEY: "test-swordfish-credential-key-at-least-32-bytes",
} as const;

describe("process entrypoints", () => {
  test("the Bebop CLI prints usage and exits cleanly", async () => {
    const outcome = await run("apps/bebop/src/cli.ts", ["--help"]);
    expect(outcome.exitCode).toBe(0);
    expect(`${outcome.stdout}${outcome.stderr}`).toContain("USAGE");
  });

  test("the Bebop CLI exits nonzero for an unknown flag", async () => {
    const outcome = await run("apps/bebop/src/cli.ts", ["health", "--nope"]);
    expect(outcome.exitCode).not.toBe(0);
  });

  test("the Bebop API refuses to start without configuration", async () => {
    // No `BEBOP_*` variables at all. A server that started anyway would be a server with no
    // database URL, listening on a port nobody chose.
    const outcome = await run("apps/bebop/src/api.ts", [], {
      env: { BEBOP_HOST: "", BEBOP_PORT: "", BEBOP_DATABASE_URL: "" },
      timeoutMs: 15_000,
    });
    expect(outcome.exitCode).not.toBe(0);
  });

  test("the Bebop worker refuses to start without configuration", async () => {
    const outcome = await run("apps/bebop/src/worker.ts", [], {
      env: { BEBOP_HOST: "", BEBOP_PORT: "", BEBOP_DATABASE_URL: "" },
      timeoutMs: 15_000,
    });
    expect(outcome.exitCode).not.toBe(0);
  });

  test("the Bebop API reports an unreachable database rather than hanging", async () => {
    const outcome = await run("apps/bebop/src/api.ts", [], {
      env: configuredWithNoDatabase,
      timeoutMs: 20_000,
    });
    expect(outcome.exitCode).not.toBe(0);
  });

  test("the sf CLI prints usage and refuses an absent daemon", async () => {
    const help = await run("apps/swordfish/src/cli.ts", ["--help"]);
    expect(help.exitCode).toBe(0);
    expect(`${help.stdout}${help.stderr}`).toContain("USAGE");

    const absent = await run("apps/swordfish/src/cli.ts", ["status", "--socket", "/tmp/swordfish-absent.sock"]);
    expect(absent.exitCode).not.toBe(0);
    expect(absent.stderr).toContain("Swordfish daemon is unavailable");

    const trailing = await run("apps/swordfish/src/cli.ts", [
      "cancel",
      "typo",
      "--socket",
      "/tmp/swordfish-absent.sock",
    ]);
    expect(trailing.exitCode).not.toBe(0);
    expect(`${trailing.stdout}${trailing.stderr}`).toContain("Unexpected argument");
  }, 30_000);

  test("the Swordfish daemon refuses to start without configuration", async () => {
    const outcome = await run("apps/swordfish/src/daemon.ts", [], {
      env: { SWORDFISH_BOUNTY_ID: "", SWORDFISH_DATABASE_PATH: "" },
      timeoutMs: 15_000,
    });
    expect(outcome.exitCode).not.toBe(0);
  });

  test("a shutdown deadline forces process exit when a finalizer never completes", async () => {
    // The fixture leaves a listening server handle open and a finalizer that never returns, so
    // without the deadline the process stays alive forever and we have to kill it. Asserting on
    // `killed` states that directly; the old wall-clock bound inferred it from an elapsed time
    // that also contained `bun` cold start, and so failed on a slow runner for unrelated reasons.
    // Under the 30s test budget, so a regression reports `killed` rather than a bare timeout.
    const outcome = await run("apps/swordfish/test/shutdown-timeout-fixture.ts", [], { timeoutMs: 20_000 });
    expect(outcome.killed).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
    expect(`${outcome.stdout}${outcome.stderr}`).toContain("Swordfish shutdown timed out");
    expect(`${outcome.stdout}${outcome.stderr}`).toContain("ShutdownTimeoutError");
  });

  test("startup reconciliation commits attention before the first Bebop registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "bebop-swordfish-reconcile-process-"));
    const socketPath = join(root, "run", "control.sock");
    const databasePath = join(root, "state", "swordfish.sqlite");
    await Promise.all([
      mkdir(join(root, "run"), { recursive: true }),
      mkdir(join(root, "state"), { recursive: true }),
      mkdir(join(root, "repository"), { recursive: true }),
      mkdir(join(root, "artifacts"), { recursive: true }),
    ]);
    const baseEnv = {
      SWORDFISH_BOUNTY_ID: "bty-reconcile-process",
      SWORDFISH_VM_ID: "vm-reconcile-process",
      SWORDFISH_REPOSITORY: "withco/bebop",
      SWORDFISH_ASSIGNED_BRANCH: "bounty/bty-reconcile-process",
      SWORDFISH_BEBOP_TOKEN: "reconcile-process-token",
      SWORDFISH_DATABASE_PATH: databasePath,
      SWORDFISH_CONTROL_SOCKET_PATH: socketPath,
      SWORDFISH_REPOSITORY_PATH: join(root, "repository"),
      SWORDFISH_ARTIFACT_ROOT: join(root, "artifacts"),
      SWORDFISH_OPEN_CODE_BASE_URL: "http://127.0.0.1:4096/",
      SWORDFISH_HEARTBEAT_INTERVAL: "50 millis",
      SWORDFISH_RECONNECT_MINIMUM_DELAY: "20 millis",
      SWORDFISH_RECONNECT_MAXIMUM_DELAY: "100 millis",
      SWORDFISH_SHUTDOWN_TIMEOUT: "1 second",
    } as const;
    let daemon: RunningProcess | undefined;
    let peer: ReturnType<typeof Bun.serve> | undefined;
    try {
      daemon = startProcess("apps/swordfish/dist/daemon.mjs", {
        ...baseEnv,
        SWORDFISH_BEBOP_WEB_SOCKET_URL: "ws://127.0.0.1:1/swordfish",
      });
      await waitForControlStatus(socketPath, daemon);
      await daemon.stop();
      daemon = undefined;

      const database = new Database(databasePath);
      try {
        database.run(
          `INSERT INTO reconciliation_records
            (record_id, kind, path, pid, status, detail, updated_at)
           VALUES (?, 'worktree', ?, NULL, 'running', NULL, ?)`,
          ["worktree-interrupted", join(root, "missing-worktree"), "2026-07-29T00:00:00.000Z"],
        );
      } finally {
        database.close();
      }

      const registrationCursors: Array<number> = [];
      const receivedEvents: Array<{ readonly sequence: number; readonly type: string }> = [];
      peer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, server) {
          const protocol = request.headers.get("sec-websocket-protocol");
          const upgraded = server.upgrade(request, {
            headers: protocol === null ? undefined : { "sec-websocket-protocol": protocol },
            data: undefined,
          });
          return upgraded ? undefined : new Response("upgrade required", { status: 426 });
        },
        websocket: {
          message(socket, data) {
            const message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<
              string,
              unknown
            >;
            if (message["type"] === "register" && typeof message["lastProducedEventSequence"] === "number") {
              registrationCursors.push(message["lastProducedEventSequence"]);
              socket.send(
                JSON.stringify({
                  type: "registered",
                  protocolVersion: 1,
                  connectionId: `conn-reconcile-${registrationCursors.length}`,
                  bountyId: "bty-reconcile-process",
                  vmId: "vm-reconcile-process",
                  serverTime: "2026-07-29T00:00:00.000Z",
                  acknowledgedThrough: 0,
                }),
              );
            } else if (message["type"] === "event" && typeof message["sequence"] === "number") {
              const event = message["event"] as Record<string, unknown> | undefined;
              receivedEvents.push({ sequence: message["sequence"], type: String(event?.["type"]) });
            }
          },
        },
      });

      daemon = startProcess("apps/swordfish/dist/daemon.mjs", {
        ...baseEnv,
        SWORDFISH_BEBOP_WEB_SOCKET_URL: `ws://127.0.0.1:${peer.port}/swordfish`,
      });
      const status = await waitForControlStatus(socketPath, daemon);
      await waitForCondition(
        () => registrationCursors.length >= 1 && receivedEvents.some((event) => event.type === "attention_required"),
        "reconciled registration and attention event",
      );

      expect(registrationCursors[0]).toBe(2);
      expect(receivedEvents).toEqual([
        { sequence: 1, type: "stage_changed" },
        { sequence: 2, type: "attention_required" },
      ]);
      expect(JSON.parse(status.stdout)).toMatchObject({
        stage: "needs_attention",
        recentEvents: [{ sequence: 1 }, { sequence: 2, event: { type: "attention_required" } }],
      });

      const cancelled = await run("apps/swordfish/dist/cli.mjs", ["cancel", "--socket", socketPath], {
        // This daemon was provisioned with no operator verifier, so it enforces nothing and
        // accepts any credential; the input still has to arrive, because the CLI always asks
        // for one before a mutating command (ADR 0038).
        stdin: "bebop_op_entrypoint-cancel\n",
      });
      expect(cancelled.exitCode).toBe(0);
      await waitForCondition(() => receivedEvents.some((event) => event.sequence === 4), "local cancellation delivery");
      expect(receivedEvents.slice(-2)).toEqual([
        { sequence: 3, type: "stage_changed" },
        { sequence: 4, type: "stage_changed" },
      ]);
      expect(daemon.child.exitCode).toBeNull();
      const cancelledStatus = await run("apps/swordfish/dist/cli.mjs", ["status", "--socket", socketPath, "--json"]);
      expect(cancelledStatus.exitCode).toBe(0);
      expect(JSON.parse(cancelledStatus.stdout)).toMatchObject({ stage: "cancelled" });
      await daemon.stop();
      daemon = undefined;
    } finally {
      if (daemon !== undefined && daemon.child.exitCode === null && daemon.child.signalCode === null) {
        await daemon.stop();
      }
      void peer?.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a SIGKILL before acknowledgement preserves the durable event for replay after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "bebop-swordfish-process-"));
    const socketPath = join(root, "run", "control.sock");
    const databasePath = join(root, "state", "swordfish.sqlite");
    await Promise.all([
      mkdir(join(root, "run"), { recursive: true }),
      mkdir(join(root, "state"), { recursive: true }),
      mkdir(join(root, "repository"), { recursive: true }),
      mkdir(join(root, "artifacts"), { recursive: true }),
    ]);
    const eventSequences: Array<number> = [];
    let registrations = 0;
    let acknowledgeEvents = false;
    const peer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const protocol = request.headers.get("sec-websocket-protocol");
        const upgraded = server.upgrade(request, {
          headers: protocol === null ? undefined : { "sec-websocket-protocol": protocol },
        });
        return upgraded ? undefined : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, data) {
          const message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<
            string,
            unknown
          >;
          if (message["type"] === "register") {
            registrations += 1;
            socket.send(
              JSON.stringify({
                type: "registered",
                protocolVersion: 1,
                connectionId: `conn-process-${registrations}`,
                bountyId: "bty-process",
                vmId: "vm-process",
                serverTime: "2026-07-29T00:00:00.000Z",
                acknowledgedThrough: 0,
              }),
            );
          } else if (message["type"] === "event" && typeof message["sequence"] === "number") {
            eventSequences.push(message["sequence"]);
            if (acknowledgeEvents) {
              socket.send(
                JSON.stringify({
                  type: "event_acknowledged",
                  protocolVersion: 1,
                  bountyId: "bty-process",
                  vmId: "vm-process",
                  acknowledgedThrough: message["sequence"],
                }),
              );
            }
          }
        },
      },
    });
    const env = {
      SWORDFISH_BOUNTY_ID: "bty-process",
      SWORDFISH_VM_ID: "vm-process",
      SWORDFISH_REPOSITORY: "withco/bebop",
      SWORDFISH_ASSIGNED_BRANCH: "bounty/bty-process",
      SWORDFISH_BEBOP_WEB_SOCKET_URL: `ws://127.0.0.1:${peer.port}/swordfish`,
      SWORDFISH_BEBOP_TOKEN: "process-token",
      SWORDFISH_DATABASE_PATH: databasePath,
      SWORDFISH_CONTROL_SOCKET_PATH: socketPath,
      SWORDFISH_REPOSITORY_PATH: join(root, "repository"),
      SWORDFISH_ARTIFACT_ROOT: join(root, "artifacts"),
      SWORDFISH_OPEN_CODE_BASE_URL: "http://127.0.0.1:4096/",
      SWORDFISH_HEARTBEAT_INTERVAL: "50 millis",
      SWORDFISH_RECONNECT_MINIMUM_DELAY: "20 millis",
      SWORDFISH_RECONNECT_MAXIMUM_DELAY: "100 millis",
      SWORDFISH_SHUTDOWN_TIMEOUT: "1 second",
    } as const;
    let daemon: RunningProcess | undefined;
    let competingDaemon: RunningProcess | undefined;
    try {
      daemon = startProcess("apps/swordfish/dist/daemon.mjs", env);
      const before = await waitForControlStatus(socketPath, daemon);
      expect(JSON.parse(before.stdout)).toMatchObject({
        stage: "interactive",
        bebopConnection: { acknowledgedThrough: 0, pendingEventCount: 1 },
        recentEvents: [{ sequence: 1 }],
      });
      await waitForCondition(() => eventSequences.length >= 1, "the first process delivery");

      const databaseAlias = join(root, "state-alias");
      await symlink(join(root, "state"), databaseAlias, "dir");
      competingDaemon = startProcess("apps/swordfish/dist/daemon.mjs", {
        ...env,
        SWORDFISH_DATABASE_PATH: join(databaseAlias, basename(databasePath)),
        SWORDFISH_CONTROL_SOCKET_PATH: join(root, "run", "other-control.sock"),
      });
      expect(await waitForProcessExit(competingDaemon)).not.toBe(0);
      expect(competingDaemon.output()).toContain("Could not use Swordfish control socket");

      daemon.child.kill("SIGKILL");
      await new Promise<void>((resolve) => daemon?.child.once("close", () => resolve()));
      acknowledgeEvents = true;
      daemon = startProcess("apps/swordfish/dist/daemon.mjs", env);
      await waitForControlStatus(socketPath, daemon);
      await waitForCondition(() => eventSequences.length >= 2, "the restarted process replay");
      // Polled in-process rather than by spawning `sf` every 25ms: this waits on the daemon's
      // acknowledgement cursor, and a spawned probe would make the poll interval hostage to
      // `bun` cold-start instead. The packed CLI is still driven below, where it is the subject.
      await waitForCondition(async () => {
        const response = await requestSwordfishStatus(socketPath).catch(() => undefined);
        if (response?.type !== "success") return false;
        const connection = response.result.snapshot.bebopConnection;
        return connection.acknowledgedThrough === 1 && connection.pendingEventCount === 0;
      }, "the restarted process acknowledgement");
      expect(eventSequences).toEqual([1, 1]);

      const cancelled = await run("apps/swordfish/dist/cli.mjs", ["cancel", "--socket", socketPath], {
        stdin: "bebop_op_entrypoint-cancel\n",
      });
      expect(cancelled.exitCode).toBe(0);
      expect(daemon.child.exitCode).toBeNull();
    } finally {
      if (
        competingDaemon !== undefined &&
        competingDaemon.child.exitCode === null &&
        competingDaemon.child.signalCode === null
      ) {
        await competingDaemon.stop();
      }
      if (daemon !== undefined && daemon.child.exitCode === null && daemon.child.signalCode === null) {
        await daemon.stop();
      }
      void peer.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  const postgresTest = adminDatabaseUrl() === null ? test.skip : test;

  postgresTest(
    "packed API and worker share state and continue after restart",
    async () => {
      const database = await createDisposableDatabase("packed-processes");
      const port = await availablePort();
      const token = "bebop_packed-process-bootstrap-token";
      const baseUrl = `http://127.0.0.1:${port}`;
      const env = {
        BEBOP_HOST: "127.0.0.1",
        BEBOP_PORT: String(port),
        BEBOP_DATABASE_URL: database.url,
        BEBOP_PUBLIC_BASE_URL: "https://bebop.test.invalid/",
        BEBOP_ARTIFACT_ROOT: "/tmp/bebop-packed-process-test",
        BEBOP_HEARTBEAT_INTERVAL: "200 millis",
        BEBOP_SWORDFISH_STALE_AFTER: "1 second",
        BEBOP_MAX_PROTOCOL_MESSAGE_BYTES: "262144",
        BEBOP_SHUTDOWN_TIMEOUT: "1 second",
        BEBOP_WORKER_POLL_INTERVAL: "50 millis",
        BEBOP_JOB_RETRY_DELAY: "10 millis",
        BEBOP_JOB_LEASE_DURATION: "2 seconds",
        BEBOP_SWORDFISH_CREDENTIAL_KEY: "packed-process-swordfish-key-at-least-32-bytes",
        BEBOP_BOOTSTRAP_API_TOKEN: token,
      } as const;
      const authorization = { authorization: `Bearer ${token}` };
      let api: RunningProcess | undefined;
      let worker: RunningProcess | undefined;
      try {
        api = startProcess("apps/bebop/dist/api.mjs", env);
        const health = await waitForResponse(`${baseUrl}/api/health`);
        expect(health.status).toBe(200);
        worker = startProcess("apps/bebop/dist/worker.mjs", env);

        const created = await fetch(`${baseUrl}/api/bounties`, {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json", "idempotency-key": "packed-1" },
          body: JSON.stringify({
            repository: "withco/bebop",
            baseRef: "main",
            computeProfile: "small",
            primaryContext: [],
          }),
        });
        expect(created.status).toBe(201);
        const bountyId = ((await created.json()) as { bountyId: string }).bountyId;
        expect(
          (
            await waitForResponse(
              `${baseUrl}/api/bounties/${bountyId}/attachments`,
              { headers: authorization },
              (response) => response.status === 200,
            )
          ).status,
        ).toBe(200);

        await worker.stop();
        await api.stop();
        worker = undefined;
        api = undefined;

        api = startProcess("apps/bebop/dist/api.mjs", env);
        await waitForResponse(`${baseUrl}/api/health`);
        worker = startProcess("apps/bebop/dist/worker.mjs", env);
        const restored = await waitForResponse(`${baseUrl}/api/bounties/${bountyId}`, { headers: authorization });
        expect(restored.status).toBe(200);
        expect(((await restored.json()) as { bountyId: string }).bountyId).toBe(bountyId);

        const second = await fetch(`${baseUrl}/api/bounties`, {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json", "idempotency-key": "packed-2" },
          body: JSON.stringify({
            repository: "withco/bebop",
            baseRef: "main",
            computeProfile: "small",
            primaryContext: [],
          }),
        });
        const secondId = ((await second.json()) as { bountyId: string }).bountyId;
        expect(
          (
            await waitForResponse(
              `${baseUrl}/api/bounties/${secondId}/attachments`,
              { headers: authorization },
              (response) => response.status === 200,
            )
          ).status,
        ).toBe(200);
      } finally {
        await worker?.stop().catch(() => undefined);
        await api?.stop().catch(() => undefined);
        await database.drop();
      }
    },
    60_000,
  );

  postgresTest("a fresh packed API requires an explicit bootstrap token", async () => {
    const database = await createDisposableDatabase("missing-bootstrap");
    try {
      const outcome = await run("apps/bebop/dist/api.mjs", [], {
        env: {
          ...configuredWithNoDatabase,
          BEBOP_PORT: String(await availablePort()),
          BEBOP_DATABASE_URL: database.url,
          BEBOP_SWORDFISH_CREDENTIAL_KEY: "missing-bootstrap-swordfish-key-at-least-32-bytes",
        },
        unsetEnv: ["BEBOP_BOOTSTRAP_API_TOKEN"],
      });
      expect(outcome.exitCode).not.toBe(0);
      expect(`${outcome.stdout}${outcome.stderr}`).toContain("BEBOP_BOOTSTRAP_API_TOKEN is required");
    } finally {
      await database.drop();
    }
  });
});
