// The maintained local system harness — process helpers.
//
// This is the production-quality follow-up to the throwaway real-process loopback probe
// (`.scratch/local-system-harness/brief.md`). It launches only packed `dist/*.mjs` artifacts
// and drives their public HTTP, WebSocket, CLI, and Unix-socket interfaces; it never imports
// app source and never writes either database directly. The worker hands the machine
// credential to a local supervisor through the one-shot bootstrap artifact the fake lifecycle
// provider writes (`apps/bebop/src/lifecycle/provider.ts`), which is the credential path the
// probe found missing.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
    options?: { readonly env?: Readonly<Record<string, string>>; readonly stdin?: string; readonly timeoutMs?: number },
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

export function describe(error: unknown): string {
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
  throw new Error(`Timed out waiting for ${description}${lastError === undefined ? "" : `: ${describe(lastError)}`}`);
}

/** A fleet runner: every process is tracked for bounded shutdown and teardown. */
export async function makeFleet(): Promise<LocalFleet> {
  const root = join(await makeScratchRoot(), "fleet");
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
          return { stdout: output, stderr: "", exitCode: exited.exitCode, signal: exited.signal };
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
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        if (options?.stdin !== undefined) {
          child.stdin.write(options.stdin);
        }
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGTERM"), options?.timeoutMs ?? 10_000);
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          resolveRun({ stdout, stderr, exitCode, signal });
        });
      }),
    stopAll: async () => {
      await Promise.all(processes.map((processToStop) => processToStop.stop().catch(() => undefined)));
    },
    clean: async () => {
      await fleet.stopAll();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
  return fleet;
}

async function makeScratchRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "bebop-local-system-"));
}
