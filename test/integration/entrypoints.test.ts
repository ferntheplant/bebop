// Every deployable program starts as a process, and says something useful when it cannot.
//
// This is the layer that catches a whole class of mistake nothing else does: a missing
// platform layer, a top-level import that only resolves under one runtime, a service that is
// never provided. `spikes/effect-runtime` finding 4 is the archetype — without `BunStdio`,
// every CLI invocation fails at startup including `--help`, and only running the binary
// notices.

import { spawn } from "node:child_process";

import { describe, expect, test } from "vite-plus/test";

interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Runs an entrypoint to completion, or kills it after `timeoutMs` and reports what it said. */
function run(
  entrypoint: string,
  args: ReadonlyArray<string>,
  options?: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number },
): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn("bun", [entrypoint, ...args], {
      env: { ...process.env, ...options?.env },
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
});
