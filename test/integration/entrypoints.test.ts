// Every deployable program starts as a process, and says something useful when it cannot.
//
// This is the layer that catches a whole class of mistake nothing else does: a missing
// platform layer, a top-level import that only resolves under one runtime, a service that is
// never provided. `spikes/effect-runtime` finding 4 is the archetype — without `BunStdio`,
// every CLI invocation fails at startup including `--help`, and only running the binary
// notices.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { adminDatabaseUrl, createDisposableDatabase } from "@bebop/testkit";
import { describe, expect, test } from "vite-plus/test";

interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
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
  },
): Promise<Outcome> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...options?.env };
    for (const name of options?.unsetEnv ?? []) {
      delete env[name];
    }
    const child = spawn("bun", [entrypoint, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), options?.timeoutMs ?? 10_000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
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
        }, 5_000);
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

async function waitForResponse(
  url: string,
  init?: RequestInit,
  accept: (response: Response) => boolean = (response) => response.status < 500,
): Promise<Response> {
  const deadline = Date.now() + 10_000;
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

  test("the Swordfish entrypoints still start", async () => {
    // Milestone 4 builds these; today they are placeholders, and this asserts only that the
    // workspace's other two programs are runnable.
    for (const [entrypoint, expected] of [
      ["apps/swordfish/src/daemon.ts", "swordfish"],
      ["apps/swordfish/src/cli.ts", "sf"],
    ] as const) {
      const outcome = await run(entrypoint, []);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe(`${expected}\n`);
    }
  });

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
    30_000,
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
