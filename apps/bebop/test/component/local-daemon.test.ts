// The local Swordfish supervisor's decisions, against a substituted process runner: no daemon is
// spawned here, and no test waits on one. What is under test is what a retried provision does to
// a machine that is already running, what it does to a record whose pid now belongs to something
// else, and what a stop does to a daemon that will not exit.
//
// It sits here rather than beside its source because it stubs a service and builds a real bounty
// root on disk, and a unit test in this repo does neither
// ([Tests are layered by what they bring up (ADR
// 0021)](../../../../docs/adr/0021-tests-are-layered-by-what-they-bring-up.md)). It is the one
// component suite that needs no database: the supervisor's collaborators are the process runner
// and the filesystem, and only the first of them is substituted.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BountyId, GitRef, RepositorySlug, VmId } from "@bebop/contracts";
import { Duration, Effect, Layer, Redacted, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";

import type { LocalDaemonSpec, LocalDaemonSettings } from "#src/lifecycle/local-daemon.ts";
import {
  localBountyPaths,
  LocalProcessRunner,
  LocalSwordfishSupervisor,
  LocalSwordfishSupervisorLayer,
} from "#src/lifecycle/local-daemon.ts";

const bountyId = Schema.decodeUnknownSync(BountyId)("bty-01jz8j3d9f4x");
const vmId = Schema.decodeUnknownSync(VmId)("vm_01JZ8J3D9F4X");
const spec: LocalDaemonSpec = {
  bountyId,
  vmId,
  repository: Schema.decodeUnknownSync(RepositorySlug)("withco/bebop"),
  assignedBranch: Schema.decodeUnknownSync(GitRef)(`bounty/${bountyId}`),
  swordfishToken: Redacted.make("swordfish-token"),
  operatorCredentialVerifier: "verifier-digest",
};

let roots: Array<string> = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

interface RunnerScript {
  /** Live pids, each with the start time the operating system would report for it. */
  readonly alive: Map<number, string>;
  readonly spawned: Array<{ readonly command: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> }>;
  readonly ran: Array<ReadonlyArray<string>>;
  readonly signalled: Array<readonly [number, string]>;
  /** Processes that ignore SIGTERM, so a stop has to escalate. */
  readonly stubborn: Set<number>;
}

function fakeRunner(script: RunnerScript, options?: { readonly nextPid?: number; readonly cloneFails?: boolean }) {
  let nextPid = options?.nextPid ?? 4_100;
  let nextStart = 0;
  return Layer.sync(LocalProcessRunner)(() => ({
    spawnDetached: ({ command, env }) =>
      Effect.sync(() => {
        const pid = nextPid;
        nextPid += 1;
        nextStart += 1;
        script.spawned.push({ command, env });
        script.alive.set(pid, `start-${nextStart}`);
        return pid;
      }),
    identify: (pid) =>
      Effect.sync(() => {
        const startedAt = script.alive.get(pid);
        return startedAt === undefined ? undefined : { startedAt, command: `bun /packed/daemon.mjs (${pid})` };
      }),
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
  options?: { readonly cloneFails?: boolean; readonly stopGracePeriod?: Duration.Duration },
): Promise<A> {
  const root = await mkdtemp(join(tmpdir(), "bebop-local-daemon-"));
  roots.push(root);
  const settings: LocalDaemonSettings = {
    root,
    swordfishEntrypoint: "/packed/daemon.mjs",
    bebopWebSocketUrl: "ws://127.0.0.1:8080/swordfish",
    openCodeBaseUrl: "http://127.0.0.1:4096/",
    gitRemoteBase: "https://github.com/",
    heartbeatInterval: Duration.seconds(5),
    reconnectMinimumDelay: Duration.seconds(5),
    reconnectMaximumDelay: Duration.seconds(20),
    shutdownTimeout: Duration.seconds(10),
    stopGracePeriod: options?.stopGracePeriod ?? Duration.millis(200),
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
  return { alive: new Map(), spawned: [], ran: [], signalled: [], stubborn: new Set() };
}

async function readMachineRecord(path: string): Promise<{ vmId: string; pid: number; startedAt: string }> {
  return JSON.parse(await readFile(path, "utf8")) as { vmId: string; pid: number; startedAt: string };
}

describe("the local Swordfish supervisor", () => {
  test("starts a daemon, clones the working copy, and records the machine", async () => {
    const script = emptyScript();
    const paths = await withSupervisor(script, (supervisor) => supervisor.ensureRunning(spec));

    expect(script.spawned).toHaveLength(1);
    expect(script.spawned[0]?.command).toEqual(["bun", "/packed/daemon.mjs"]);
    expect(script.ran[0]?.slice(0, 3)).toEqual(["git", "clone", "https://github.com/withco/bebop.git"]);
    expect(await readMachineRecord(paths.machinePath)).toEqual({ vmId, pid: 4_100, startedAt: "start-1" });
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
    expect(await readFile(paths.machinePath, "utf8")).not.toContain("swordfish-token");
  });

  test("names every variable Swordfish's own configuration reads", async () => {
    // Bebop derives these names from Swordfish's field names rather than transcribing them, so
    // this is what keeps the derivation honest: the set is exactly the daemon's required
    // configuration, and a field whose name stopped round-tripping would drop out of it.
    const script = emptyScript();
    await withSupervisor(script, (supervisor) => supervisor.ensureRunning(spec));

    expect(Object.keys(script.spawned[0]?.env ?? {}).sort()).toEqual(
      [
        "SWORDFISH_ARTIFACT_ROOT",
        "SWORDFISH_ASSIGNED_BRANCH",
        "SWORDFISH_BEBOP_TOKEN",
        "SWORDFISH_BEBOP_WEB_SOCKET_URL",
        "SWORDFISH_BOUNTY_ID",
        "SWORDFISH_CONTROL_SOCKET_PATH",
        "SWORDFISH_DATABASE_PATH",
        "SWORDFISH_HEARTBEAT_INTERVAL",
        "SWORDFISH_OPEN_CODE_BASE_URL",
        "SWORDFISH_OPERATOR_CREDENTIAL_VERIFIER",
        "SWORDFISH_RECONNECT_MAXIMUM_DELAY",
        "SWORDFISH_RECONNECT_MINIMUM_DELAY",
        "SWORDFISH_REPOSITORY",
        "SWORDFISH_REPOSITORY_PATH",
        "SWORDFISH_SHUTDOWN_TIMEOUT",
        "SWORDFISH_VM_ID",
      ].sort(),
    );
  });

  test("emits durations in the syntax Swordfish parses back, not the one it prints", async () => {
    const script = emptyScript();
    await withSupervisor(script, (supervisor) => supervisor.ensureRunning(spec));
    const env = script.spawned[0]?.env ?? {};

    expect(env["SWORDFISH_HEARTBEAT_INTERVAL"]).toBe("5000 millis");
    expect(env["SWORDFISH_RECONNECT_MAXIMUM_DELAY"]).toBe("20000 millis");
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

  test("a recorded machine that is no longer running is replaced rather than reattached to", async () => {
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

  test("a pid the operating system has reused is not mistaken for the bounty's machine", async () => {
    // The reason the record carries a start time at all. Without it this is indistinguishable
    // from a live daemon, and the provision below would skip starting one while `stop` went on
    // to signal a stranger's process on the operator's own host.
    const script = emptyScript();
    await withSupervisor(script, (supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.ensureRunning(spec);
        // Same pid, different process: the daemon exited and something else took the slot.
        yield* Effect.sync(() => script.alive.set(4_100, "start-somebody-else"));
        yield* supervisor.ensureRunning(spec);
      }),
    );

    expect(script.spawned).toHaveLength(2);
    // Nothing was signalled: the stranger holding the old pid is left completely alone.
    expect(script.signalled).toEqual([]);
  });

  test("a stop whose recorded pid has been reused signals nothing and clears the record", async () => {
    const script = emptyScript();
    const root = await withSupervisor(script, (supervisor, current) =>
      Effect.gen(function* () {
        yield* supervisor.ensureRunning(spec);
        yield* Effect.sync(() => script.alive.set(4_100, "start-somebody-else"));
        yield* supervisor.stop(bountyId);
        return current;
      }),
    );

    expect(script.signalled).toEqual([]);
    expect(script.alive.get(4_100)).toBe("start-somebody-else");
    await expect(readFile(localBountyPaths(root, bountyId).machinePath, "utf8")).rejects.toThrow();
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
    await expect(readFile(paths.machinePath, "utf8")).rejects.toThrow();
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
      { stopGracePeriod: Duration.millis(60) },
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
