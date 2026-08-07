// The supervisor's decisions, against a substituted process runner: no daemon is spawned here,
// and no test waits on one. What is under test is what a retried provision does to a machine that
// is already running, and what a stop does to one that will not exit.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BountyId, GitRef, RepositorySlug } from "@bebop/contracts";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";

import type { LocalDaemonSpec } from "#src/lifecycle/local-daemon.ts";
import {
  localBountyPaths,
  LocalProcessRunner,
  LocalSwordfishSupervisor,
  LocalSwordfishSupervisorLayer,
} from "#src/lifecycle/local-daemon.ts";

const bountyId = Schema.decodeUnknownSync(BountyId)("bty-01jz8j3d9f4x");
const spec: LocalDaemonSpec = {
  bountyId,
  vmId: `vm-${bountyId}`,
  repository: Schema.decodeUnknownSync(RepositorySlug)("withco/bebop"),
  assignedBranch: Schema.decodeUnknownSync(GitRef)(`bounty/${bountyId}`),
  swordfishToken: "swordfish-token",
  operatorCredentialVerifier: "verifier-digest",
};

let roots: Array<string> = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

interface RunnerScript {
  readonly alive: Set<number>;
  readonly spawned: Array<{ readonly command: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> }>;
  readonly ran: Array<ReadonlyArray<string>>;
  readonly signalled: Array<readonly [number, string]>;
  /** Processes that ignore SIGTERM, so a stop has to escalate. */
  readonly stubborn: Set<number>;
}

function fakeRunner(script: RunnerScript, options?: { readonly nextPid?: number; readonly cloneFails?: boolean }) {
  let nextPid = options?.nextPid ?? 4_100;
  return Layer.sync(LocalProcessRunner)(() => ({
    spawnDetached: ({ command, env }) =>
      Effect.sync(() => {
        const pid = nextPid;
        nextPid += 1;
        script.spawned.push({ command, env });
        script.alive.add(pid);
        return pid;
      }),
    isAlive: (pid) => Effect.sync(() => script.alive.has(pid)),
    signal: (pid, signal) =>
      Effect.sync(() => {
        script.signalled.push([pid, signal]);
        if (signal === "SIGKILL" || !script.stubborn.has(pid)) script.alive.delete(pid);
      }),
    run: ({ command }) =>
      Effect.suspend(() => {
        script.ran.push(command);
        return options?.cloneFails === true
          ? Effect.fail(new Error("fatal: repository not found"))
          : Effect.promise(async () => {
              // A real clone leaves a `.git` behind, which is how a retry recognises it.
              const destination = command[command.length - 1] ?? "";
              await mkdir(join(destination, ".git"), { recursive: true });
              await writeFile(join(destination, ".git", "HEAD"), "ref: refs/heads/main\n");
            });
      }),
  }));
}

async function withSupervisor<A>(
  script: RunnerScript,
  use: (supervisor: typeof LocalSwordfishSupervisor.Service, root: string) => Effect.Effect<A, unknown>,
  options?: { readonly cloneFails?: boolean; readonly stopGracePeriodMillis?: number },
): Promise<A> {
  const root = await mkdtemp(join(tmpdir(), "bebop-local-daemon-"));
  roots.push(root);
  const settings = {
    root,
    swordfishEntrypoint: "/packed/daemon.mjs",
    bebopWebSocketUrl: "ws://127.0.0.1:8080/swordfish",
    openCodeBaseUrl: "http://127.0.0.1:4096/",
    gitRemoteBase: "https://github.com/",
    heartbeatInterval: "5 seconds",
    reconnectMinimumDelay: "1 second",
    reconnectMaximumDelay: "30 seconds",
    shutdownTimeout: "10 seconds",
    stopGracePeriodMillis: options?.stopGracePeriodMillis ?? 200,
  };
  const layer = LocalSwordfishSupervisorLayer(settings).pipe(
    Layer.provide(fakeRunner(script, options === undefined ? {} : options)),
  );
  return await Effect.runPromise(
    Effect.gen(function* () {
      const supervisor = yield* LocalSwordfishSupervisor;
      return yield* use(supervisor, root);
    }).pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>,
  );
}

function emptyScript(): RunnerScript {
  return { alive: new Set(), spawned: [], ran: [], signalled: [], stubborn: new Set() };
}

describe("the local Swordfish supervisor", () => {
  test("starts a daemon, clones the working copy, and records the pid", async () => {
    const script = emptyScript();
    const paths = await withSupervisor(script, (supervisor) => supervisor.ensureRunning(spec));

    expect(script.spawned).toHaveLength(1);
    expect(script.spawned[0]?.command).toEqual(["bun", "/packed/daemon.mjs"]);
    expect(script.ran[0]?.slice(0, 3)).toEqual(["git", "clone", "https://github.com/withco/bebop.git"]);
    expect(await readFile(paths.pidPath, "utf8")).toBe("4100\n");
  });

  test("hands the daemon its credentials through the environment and never through a file", async () => {
    // The whole reason the bootstrap artifact is gone: the machine credential goes from
    // derivation into a process environment without ever touching disk.
    const script = emptyScript();
    const paths = await withSupervisor(script, (supervisor) => supervisor.ensureRunning(spec));
    const env = script.spawned[0]?.env ?? {};

    expect(env["SWORDFISH_BEBOP_TOKEN"]).toBe("swordfish-token");
    expect(env["SWORDFISH_OPERATOR_CREDENTIAL_VERIFIER"]).toBe("verifier-digest");
    expect(env["SWORDFISH_BOUNTY_ID"]).toBe(bountyId);
    expect(env["SWORDFISH_ASSIGNED_BRANCH"]).toBe(`bounty/${bountyId}`);
    expect(env["SWORDFISH_CONTROL_SOCKET_PATH"]).toBe(paths.controlSocketPath);
    const written = await readFile(paths.pidPath, "utf8");
    expect(written).not.toContain("swordfish-token");
  });

  test("a retried provision reattaches instead of starting a second daemon", async () => {
    // The property that matters after a worker crash: one bounty, one daemon, and the running
    // one is left strictly alone rather than restarted.
    const script = emptyScript();
    await withSupervisor(script, (supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.ensureRunning(spec);
        yield* supervisor.ensureRunning(spec);
        yield* supervisor.ensureRunning(spec);
      }),
    );

    expect(script.spawned).toHaveLength(1);
    expect(script.signalled).toEqual([]);
    // The clone is not repeated either: the working copy is the same machine's, not a new one.
    expect(script.ran).toHaveLength(1);
  });

  test("a recorded pid that is no longer running is replaced rather than reattached to", async () => {
    const script = emptyScript();
    await withSupervisor(script, (supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.ensureRunning(spec);
        // The daemon died without anyone stopping it — a crash, or a reboot that reused nothing.
        yield* Effect.sync(() => script.alive.clear());
        yield* supervisor.ensureRunning(spec);
      }),
    );

    expect(script.spawned).toHaveLength(2);
  });

  test("stop signals, waits, and clears the record", async () => {
    const script = emptyScript();
    const root = await withSupervisor(script, (supervisor, current) =>
      Effect.gen(function* () {
        yield* supervisor.ensureRunning(spec);
        yield* supervisor.stop(bountyId);
        return current;
      }),
    );

    expect(script.signalled).toEqual([[4100, "SIGTERM"]]);
    expect(script.alive.size).toBe(0);
    const paths = localBountyPaths(root, bountyId);
    await expect(readFile(paths.pidPath, "utf8")).rejects.toThrow();
  });

  test("stopping a daemon that is not running succeeds", async () => {
    const script = emptyScript();
    await withSupervisor(script, (supervisor) => supervisor.stop(bountyId));
    expect(script.signalled).toEqual([]);
  });

  test("a daemon that ignores SIGTERM is killed rather than waited on forever", async () => {
    const script = emptyScript();
    await withSupervisor(
      script,
      (supervisor) =>
        Effect.gen(function* () {
          yield* supervisor.ensureRunning(spec);
          yield* Effect.sync(() => script.stubborn.add(4_100));
          yield* supervisor.stop(bountyId);
        }),
      // A grace period the test can afford to wait out; the escalation is only reachable by
      // letting one elapse.
      { stopGracePeriodMillis: 60 },
    );

    expect(script.signalled).toEqual([
      [4100, "SIGTERM"],
      [4100, "SIGKILL"],
    ]);
  });

  test("a failed clone fails the provision rather than starting a daemon with no working copy", async () => {
    const script = emptyScript();
    const exit = await withSupervisor(script, (supervisor) => Effect.exit(supervisor.ensureRunning(spec)), {
      cloneFails: true,
    });

    expect(exit._tag).toBe("Failure");
    expect(script.spawned).toEqual([]);
  });
});
