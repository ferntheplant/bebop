// The maintained local system harness — process helpers.
//
// This is the production-quality follow-up to the throwaway real-process loopback probe
// (`docs/testing.md`). It launches only packed `dist/*.mjs` artifacts
// and drives their public HTTP, WebSocket, CLI, and Unix-socket interfaces; it never imports
// app source and never writes either database directly. The worker hands the machine
// credential to a local supervisor through the one-shot bootstrap artifact the fake lifecycle
// provider writes (`apps/bebop/src/lifecycle/provider.ts`), which is the credential path the
// probe found missing.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
    options?: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number },
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
export function describeError(error: unknown): string {
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

/** The bootstrap identity a local supervisor needs in order to start Swordfish. */
export interface BootstrapIdentity {
  readonly bountyId: string;
  readonly vmId: string;
  readonly swordfishToken: string;
  /** The operator credential verifier the daemon is provisioned with (ADR 0038). */
  readonly operatorCredentialVerifier: string;
}

function bootstrapPath(root: string, bountyId: string): string {
  return join(root, `${bountyId}.bootstrap`);
}

/** Reads the artifact without consuming it, for asserting on what `provision` wrote. */
export async function readBootstrapArtifact(root: string, bountyId: string): Promise<BootstrapIdentity> {
  const identity = JSON.parse(await readFile(bootstrapPath(root, bountyId), "utf8")) as BootstrapIdentity;
  assert(identity.bountyId === bountyId, `bootstrap artifact carried ${identity.bountyId}, expected ${bountyId}`);
  assert(
    typeof identity.swordfishToken === "string" && identity.swordfishToken.length > 0,
    "bootstrap artifact carried no machine credential",
  );
  assert(
    /^[0-9a-f]{64}$/.test(identity.operatorCredentialVerifier),
    "bootstrap artifact carried no operator credential verifier",
  );
  return identity;
}

/**
 * The local supervisor's half of the bootstrap handoff: take the identity, then destroy the
 * artifact.
 *
 * This is the one-shot part of "one-shot bootstrap artifact". It lives here rather than
 * inline in a test so that the artifact's removal is something the supervisor does and a
 * test can then assert about — an assertion sitting next to its own `rm` would only be
 * proving that `rm` works.
 */
export async function consumeBootstrapArtifact(root: string, bountyId: string): Promise<BootstrapIdentity> {
  const identity = await readBootstrapArtifact(root, bountyId);
  await rm(bootstrapPath(root, bountyId), { force: true });
  return identity;
}

/** Whether a plaintext bootstrap credential is still sitting on disk. */
export async function bootstrapArtifactExists(root: string, bountyId: string): Promise<boolean> {
  return await stat(bootstrapPath(root, bountyId)).then(
    () => true,
    () => false,
  );
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
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
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
