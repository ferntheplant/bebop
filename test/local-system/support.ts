// The maintained local system harness — process helpers.
//
// This is the production-quality follow-up to the throwaway real-process loopback probe
// (`docs/testing.md`). It launches only packed `dist/*.mjs` artifacts
// and drives their public HTTP, WebSocket, CLI, and Unix-socket interfaces; it never imports
// app source and never writes either database directly. The worker hands the machine
// credential to the Swordfish daemon by starting it: locally the lifecycle provider is what
// makes a daemon exist, so the harness creates a bounty and the daemon appears, exactly as it
// does for an operator ("A local Swordfish outlives the worker that started it" (ADR 0048)).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

export interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the harness killed the process for exceeding its timeout, so a failure says so. */
  readonly timedOut: boolean;
}

export interface RunningProcess {
  readonly name: string;
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly stop: (signal?: NodeJS.Signals) => Promise<Outcome>;
}

export interface LocalFleet {
  readonly root: string;
  readonly processes: Array<RunningProcess>;
  readonly start: (name: string, entrypoint: string, env: Readonly<Record<string, string>>) => RunningProcess;
  readonly run: (
    entrypoint: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly env?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
      /** Written to the child's stdin and closed, so a CLI can read one line from a pipe. */
      readonly stdin?: string;
    },
  ) => Promise<Outcome>;
  readonly stopAll: () => Promise<void>;
  readonly clean: () => Promise<void>;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Renders an unknown thrown value for a timeout message. Not `describe`: that is vitest's. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown failure";
  }
}

/** Allocates a loopback port that is free at the moment of the call. */
export async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

/** Polls `read` until it returns a value, failing the wait after `timeoutMs`. */
export async function waitFor<T>(
  description: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError === undefined ? "" : `: ${describeError(lastError)}`}`,
  );
}

/**
 * Creates the bare repository a local bounty is cloned from, under `<root>/<slug>.git`.
 *
 * The clone the provider performs is a real `git clone`; only the origin is local, so what is
 * exercised is the shipped path rather than a stub of it.
 */
export async function makeBareOrigin(root: string, slug: string): Promise<void> {
  const path = join(root, `${slug}.git`);
  await mkdir(path, { recursive: true });
  const seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  await writeFile(join(seed, "README.md"), "# local system harness fixture\n");
  const git = async (cwd: string, ...args: Array<string>) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "bebop",
        GIT_AUTHOR_EMAIL: "bebop@local",
        GIT_COMMITTER_NAME: "bebop",
        GIT_COMMITTER_EMAIL: "bebop@local",
      },
    });
    assert(result.exitCode === 0, `git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  };
  await git(root, "init", "--bare", "--initial-branch=main", path);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "seed");
  await git(seed, "remote", "add", "origin", path);
  await git(seed, "push", "origin", "main");
}

/**
 * Where the local lifecycle provider puts one bounty's machine.
 *
 * The harness derives these rather than being told them, because the layout is what an operator
 * navigates too — the runbook in `README.md` points at these same paths. It deliberately does
 * not reconstruct the daemon's environment: the machine credential goes from bebop's derivation
 * straight into the process the provider starts and is never written down, so nothing outside
 * bebop can start a daemon. That is the point, and it is why this harness no longer has a
 * supervisor of its own.
 */
export interface LocalBountyLayout {
  readonly root: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly logPath: string;
}

export function localBountyLayout(localRoot: string, bountyId: string): LocalBountyLayout {
  const root = join(localRoot, "bounties", bountyId);
  return {
    root,
    socketPath: join(root, "run", "control.sock"),
    pidPath: join(root, "run", "daemon.pid"),
    logPath: join(root, "logs", "swordfish.log"),
  };
}

/** The pid of the daemon the provider started, or undefined when it has not recorded one yet. */
export async function daemonPid(layout: LocalBountyLayout): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(layout.pidPath, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for the provider to have a live daemon recorded for this bounty, and returns its pid. */
export async function waitForDaemon(layout: LocalBountyLayout, description: string): Promise<number> {
  return await waitFor(description, async () => {
    const pid = await daemonPid(layout);
    return pid !== undefined && processIsAlive(pid) ? pid : undefined;
  });
}

/**
 * Kills a detached daemon the fleet does not own.
 *
 * Teardown needs this because a local daemon outlives the worker on purpose: nothing in the
 * fleet's own shutdown reaches it, so a test that fails before `bounty stop` would otherwise
 * leave a daemon running on the developer's machine.
 */
export async function killDaemon(layout: LocalBountyLayout): Promise<void> {
  const pid = await daemonPid(layout);
  if (pid === undefined || !processIsAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone between the check and the signal.
  }
  await waitFor(`daemon ${pid} exit`, async () => (processIsAlive(pid) ? undefined : true), 10_000);
}

/** A fleet runner: every process is tracked for bounded shutdown and teardown. */
export async function makeFleet(): Promise<LocalFleet> {
  // `clean` removes `scratch`, not `root`: the brief asks that nothing survive a run, and
  // removing only the `fleet` subdirectory would leave the `mkdtemp` parent behind on every
  // single invocation.
  const scratch = await makeScratchRoot();
  const root = join(scratch, "fleet");
  const processes: Array<RunningProcess> = [];
  let processOrdinal = 0;

  const fleet: LocalFleet = {
    root,
    processes,
    start: (name, entrypoint, env) => {
      processOrdinal += 1;
      const child = spawn("bun", [entrypoint], {
        cwd: repositoryRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const instanceName = `${String(processOrdinal).padStart(2, "0")}-${name}`;
      const running: RunningProcess = {
        name: instanceName,
        child,
        output: () => output,
        stop: async (signal = "SIGTERM") => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return {
              stdout: output,
              stderr: "",
              exitCode: child.exitCode,
              signal: child.signalCode,
              timedOut: false,
            };
          }
          child.kill(signal);
          const exited = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
            (resolveExit) => {
              const timer = setTimeout(() => {
                child.kill("SIGKILL");
              }, 5_000);
              child.once("close", (exitCode, sig) => {
                clearTimeout(timer);
                resolveExit({ exitCode, signal: sig });
              });
            },
          );
          return { stdout: output, stderr: "", exitCode: exited.exitCode, signal: exited.signal, timedOut: false };
        },
      };
      processes.push(running);
      return running;
    },
    run: (entrypoint, args, options) =>
      new Promise<Outcome>((resolveRun) => {
        const child = spawn("bun", [entrypoint, ...args], {
          cwd: repositoryRoot,
          env: { ...process.env, ...options?.env },
          stdio:
            options?.stdin === undefined ? (["ignore", "pipe", "pipe"] as const) : (["pipe", "pipe", "pipe"] as const),
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        if (child.stdout !== null) child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        if (child.stderr !== null) child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        if (options?.stdin !== undefined && child.stdin !== null) {
          child.stdin.write(options.stdin);
          child.stdin.end();
        }
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options?.timeoutMs ?? 10_000);
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          resolveRun({ stdout, stderr, exitCode, signal, timedOut });
        });
      }),
    stopAll: async () => {
      await Promise.all(processes.map((processToStop) => processToStop.stop().catch(() => undefined)));
    },
    clean: async () => {
      await fleet.stopAll();
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    },
  };
  return fleet;
}

async function makeScratchRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "bebop-local-system-"));
}
