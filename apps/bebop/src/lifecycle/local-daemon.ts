// Starting and stopping a Swordfish daemon when the "VM" is a directory on this machine.
//
// This exists because the lifecycle provider is what makes a daemon exist in both environments
// ("The local loop runs the production assembly" (ADR 0046)): in production the VM's bootstrap
// starts it, locally this does. Bebop core still only calls `provision` and `destroy`, so the
// difference stays inside the one implementation exe.dev replaces.
//
// The daemon is detached and outlives the worker that started it, and a provision that finds one
// already running leaves it alone ("A local Swordfish outlives the worker that started it"
// (ADR 0048)). That is what a VM does — it does not reboot because bebop restarted — and it is
// what makes the reconnect backoff and the disconnected state `sf status` reports mean anything
// locally.
//
// Two services rather than one: `LocalProcessRunner` is the narrow seam that touches operating
// system processes, and the supervisor holds the decisions — where a bounty's directories go,
// whether a recorded machine is still the one that was started, and how a stop escalates. The
// supervisor owns the bounty root and its machine record, so it reads and writes those files
// itself; what it never does is ask the operating system about a process. Tests replace the
// runner and exercise the decisions without spawning anything, which is the split the
// architectural rule on process execution asks for.

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BountyId, GitRef, RepositorySlug, VmId } from "@bebop/contracts";
import { VmId as VmIdSchema } from "@bebop/contracts";
import type { Redacted } from "effect";
import { Context, Data, Duration, Effect, Layer, Redacted as RedactedModule, Schema } from "effect";

export class LocalDaemonError extends Data.TaggedError("LocalDaemonError")<{
  readonly bountyId: BountyId;
  readonly operation: "clone" | "start" | "stop";
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Local Swordfish ${this.operation} failed for ${this.bountyId}: ${this.reason}.`;
  }
}

/**
 * Everything the daemon needs that only bebop knows.
 *
 * The credential stays redacted the whole way down and is unwrapped once, into the environment
 * of the process being spawned — the injection "Swordfish tokens are bounty-scoped, minted at
 * provisioning, and never rotate" (ADR 0014) describes, at a seam where the VM is a directory.
 * It is never written to disk.
 */
export interface LocalDaemonSpec {
  readonly bountyId: BountyId;
  readonly vmId: VmId;
  readonly repository: RepositorySlug;
  readonly assignedBranch: GitRef;
  readonly swordfishToken: Redacted.Redacted<string>;
  readonly operatorCredentialVerifier: string;
}

/** Where one bounty's local machine lives. Every path is derived, so two bounties never collide. */
export interface LocalBountyPaths {
  readonly root: string;
  readonly databasePath: string;
  readonly controlSocketPath: string;
  readonly repositoryPath: string;
  readonly artifactRoot: string;
  readonly logPath: string;
  readonly machinePath: string;
}

export function localBountyPaths(root: string, bountyId: BountyId): LocalBountyPaths {
  const bountyRoot = join(root, "bounties", bountyId);
  return {
    root: bountyRoot,
    databasePath: join(bountyRoot, "state", "swordfish.sqlite"),
    controlSocketPath: join(bountyRoot, "run", "control.sock"),
    repositoryPath: join(bountyRoot, "repository"),
    artifactRoot: join(bountyRoot, "artifacts"),
    logPath: join(bountyRoot, "logs", "swordfish.log"),
    machinePath: join(bountyRoot, "run", "machine.json"),
  };
}

/**
 * What the provider recorded about a bounty's machine, and what identifies it later.
 *
 * A pid on its own is a slot the operating system reuses, not a name: after a crash the number
 * in this file can belong to something else entirely, and reattaching to it or signalling it
 * would reach a stranger's process. `startedAt` is what makes the pid an identity — the kernel's
 * own start time for that process, which a reused pid cannot reproduce.
 *
 * That is the same shape as the identity exe.dev gives us. There a `vmId` names the machine and
 * `describe` asks the API whether it is still that machine; here the record names it and the
 * operating system answers the same question, so `provision` and `destroy` reason about a
 * machine in both environments rather than about a number in one of them.
 */
const LocalMachineRecord = Schema.Struct({
  vmId: VmIdSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  startedAt: Schema.NonEmptyString,
});
export type LocalMachineRecord = typeof LocalMachineRecord.Type;

const decodeMachineRecord = Schema.decodeUnknownSync(LocalMachineRecord);
const encodeMachineRecord = Schema.encodeSync(LocalMachineRecord);

/** How the operating system identifies a process that is running right now. */
export interface ProcessIdentity {
  /** The kernel's start time for this process, stable for its whole life and unique with the pid. */
  readonly startedAt: string;
  /** The command line, so a stale record can say what took the pid over instead of only that it did. */
  readonly command: string;
}

interface LocalProcessRunnerService {
  /**
   * Starts a process that survives this one, with output appended to `logPath`, and returns its
   * pid. Detachment is the whole point: a worker restart must not take the bounty's loop with it.
   */
  readonly spawnDetached: (options: {
    readonly command: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
    readonly logPath: string;
  }) => Effect.Effect<number, Error>;
  /**
   * What is running at this pid now, or `undefined` when nothing is.
   *
   * This replaces a bare liveness check because "something is alive at this pid" is not the
   * question worth asking — `LocalMachineRecord` explains why.
   */
  readonly identify: (pid: number) => Effect.Effect<ProcessIdentity | undefined>;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void>;
  /** Runs a command to completion, failing with its output when it exits non-zero. */
  readonly run: (options: { readonly command: ReadonlyArray<string> }) => Effect.Effect<void, Error>;
}

export class LocalProcessRunner extends Context.Service<LocalProcessRunner, LocalProcessRunnerService>()(
  "LocalProcessRunner",
) {}

interface LocalSwordfishSupervisorService {
  /**
   * Brings a bounty's daemon into existence, or confirms the one already running.
   *
   * Idempotent per bounty because the worker retries provisioning after a crash: a machine whose
   * record still matches the process at its pid is left strictly alone, and only a stale record
   * is replaced.
   */
  readonly ensureRunning: (spec: LocalDaemonSpec) => Effect.Effect<LocalBountyPaths, LocalDaemonError>;
  /** Stops a bounty's daemon. Stopping one that is not running succeeds. */
  readonly stop: (bountyId: BountyId) => Effect.Effect<void, LocalDaemonError>;
}

export class LocalSwordfishSupervisor extends Context.Service<
  LocalSwordfishSupervisor,
  LocalSwordfishSupervisorService
>()("LocalSwordfishSupervisor") {}

export interface LocalDaemonSettings {
  readonly root: string;
  /** The packed daemon entrypoint, since a local machine runs the same artifact production ships. */
  readonly swordfishEntrypoint: string;
  readonly bebopWebSocketUrl: string;
  readonly openCodeBaseUrl: string;
  /**
   * What the bounty's working copy is cloned from, as a base the repository slug resolves
   * against — `https://github.com/` for an operator, using their ambient git credentials.
   *
   * It is configurable because the local-system harness has to clone without a network, not
   * because a second forge is planned: a suite that reached GitHub would be neither offline nor
   * repeatable, and pointing it at a bare repository on disk keeps the clone real.
   */
  readonly gitRemoteBase: string;
  /** The daemon cadences a VM bootstrap would set. */
  readonly heartbeatInterval: Duration.Duration;
  readonly reconnectMinimumDelay: Duration.Duration;
  readonly reconnectMaximumDelay: Duration.Duration;
  readonly shutdownTimeout: Duration.Duration;
  /**
   * How long a stop waits for a signalled daemon before killing it.
   *
   * It is a setting rather than a constant because it is the one number in here a test has to
   * move: the escalation path is only reachable by waiting the period out.
   */
  readonly stopGracePeriod: Duration.Duration;
}

/** The default a local runtime uses: long enough for an outbox drain, short enough to not hang a destroy. */
export const defaultStopGracePeriod: Duration.Duration = Duration.seconds(10);
const stopPollInterval = Duration.millis(20);

/**
 * The environment variable a Swordfish configuration field is read from.
 *
 * Swordfish does not publish these names — it derives them, from its schema's field names
 * through `ConfigProvider.constantCase` under a `swordfish` prefix. Composing the machine's
 * environment is what a VM bootstrap does, so bebop necessarily knows the fields; applying the
 * same rule rather than transcribing fourteen literals is what keeps that knowledge to one
 * thing that can be wrong instead of fourteen.
 */
function swordfishVariable(field: string): string {
  return `SWORDFISH_${field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

/**
 * A duration in the one syntax Swordfish's own configuration schema parses back.
 *
 * Millis rather than `Duration.format`: that prints `5s`, which the daemon's `DurationFromString`
 * refuses — a mismatch that surfaces only as a daemon exiting at startup in a log nobody is
 * tailing (`docs/gotchas.md`). This is the only place a duration crosses into the daemon, so it
 * is the only place that has to know.
 */
function durationSetting(duration: Duration.Duration): string {
  return `${Duration.toMillis(duration)} millis`;
}

export function daemonEnvironment(
  spec: LocalDaemonSpec,
  paths: LocalBountyPaths,
  settings: LocalDaemonSettings,
): Record<string, string> {
  // Keyed by Swordfish's configuration field names, which is what a bootstrap is given. The
  // daemon's cadences are required configuration with no defaults of their own, because a VM's
  // bootstrap is what supplies them in production. Locally this is that bootstrap, so it
  // supplies them here — and the reconnect bounds are what the backoff in `sf status` runs
  // between ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)).
  const fields: Record<string, string> = {
    bountyId: spec.bountyId,
    vmId: spec.vmId,
    repository: spec.repository,
    assignedBranch: spec.assignedBranch,
    bebopWebSocketUrl: settings.bebopWebSocketUrl,
    bebopToken: RedactedModule.value(spec.swordfishToken),
    databasePath: paths.databasePath,
    controlSocketPath: paths.controlSocketPath,
    repositoryPath: paths.repositoryPath,
    artifactRoot: paths.artifactRoot,
    openCodeBaseUrl: settings.openCodeBaseUrl,
    operatorCredentialVerifier: spec.operatorCredentialVerifier,
    heartbeatInterval: durationSetting(settings.heartbeatInterval),
    reconnectMinimumDelay: durationSetting(settings.reconnectMinimumDelay),
    reconnectMaximumDelay: durationSetting(settings.reconnectMaximumDelay),
    shutdownTimeout: durationSetting(settings.shutdownTimeout),
  };
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => [swordfishVariable(field), value]));
}

/**
 * The supervisor as a value, so the provider can hold one without the whole lifecycle stack
 * having to carry `LocalSwordfishSupervisor` in its requirements — local mode is a branch inside
 * one implementation, not a shape the layers above it should have to know about.
 */
export const makeLocalSwordfishSupervisor = (
  settings: LocalDaemonSettings,
): Effect.Effect<LocalSwordfishSupervisorService, never, LocalProcessRunner> =>
  Effect.gen(function* () {
    const runner = yield* LocalProcessRunner;

    const failWith = (bountyId: BountyId, operation: "clone" | "start" | "stop", reason: string) => (cause: unknown) =>
      new LocalDaemonError({ bountyId, operation, reason, cause });

    const recordedMachine = (paths: LocalBountyPaths) =>
      Effect.tryPromise(() => readFile(paths.machinePath, "utf8")).pipe(
        Effect.map((text) => decodeMachineRecord(JSON.parse(text)) as LocalMachineRecord | undefined),
        // No record, an unreadable one, or one this bebop no longer understands all mean the
        // same thing: nothing here can be reattached to.
        Effect.orElseSucceed(() => undefined),
      );

    /**
     * The machine this record names, if that machine is still the process at its pid.
     *
     * A record whose pid now belongs to something else is stale, not live — that is the whole
     * reason the start time is recorded, and the reason a stale record is logged rather than
     * silently replaced: on an operator's own host, the process that took the pid over is
     * something they may care about.
     */
    const liveMachine = (bountyId: BountyId, paths: LocalBountyPaths) =>
      Effect.gen(function* () {
        const record = yield* recordedMachine(paths);
        if (record === undefined) return undefined;
        const actual = yield* runner.identify(record.pid);
        if (actual === undefined) return undefined;
        if (actual.startedAt === record.startedAt) return record;
        yield* Effect.logWarning("recorded machine pid now belongs to another process; treating it as gone").pipe(
          Effect.annotateLogs("bounty_id", bountyId),
          Effect.annotateLogs("vm_id", record.vmId),
          Effect.annotateLogs("pid", String(record.pid)),
          Effect.annotateLogs("actual_command", actual.command),
        );
        return undefined;
      });

    const cloneRepository = (spec: LocalDaemonSpec, paths: LocalBountyPaths) =>
      Effect.gen(function* () {
        // A clone already present is the retried provision, not a second machine. The working
        // copy is never the operator's own checkout: a dirty tree makes both the clean-room
        // worktree and the clean-tree precondition on candidate submission unverifiable
        // ("Verification runs in a clean-room worktree" (ADR 0015)).
        const cloned = yield* Effect.tryPromise(() =>
          readFile(join(paths.repositoryPath, ".git", "HEAD"), "utf8"),
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (cloned) return;
        const origin = new URL(`${spec.repository}.git`, settings.gitRemoteBase).href;
        yield* runner
          .run({ command: ["git", "clone", origin, paths.repositoryPath] })
          .pipe(
            Effect.mapError(
              failWith(spec.bountyId, "clone", `could not clone ${spec.repository} into the bounty working copy`),
            ),
          );
      });

    const ensureRunning = (spec: LocalDaemonSpec) =>
      Effect.gen(function* () {
        const paths = localBountyPaths(settings.root, spec.bountyId);
        yield* Effect.tryPromise(async () => {
          // `mkdir` applies `mode` only when it creates the directory, so the `chmod` is what
          // guarantees `0700` on a root whose subtree holds a bounty's whole working state.
          await mkdir(settings.root, { recursive: true, mode: 0o700 });
          await chmod(settings.root, 0o700);
          await Promise.all([
            mkdir(join(paths.root, "run"), { recursive: true }),
            mkdir(join(paths.root, "state"), { recursive: true }),
            mkdir(join(paths.root, "logs"), { recursive: true }),
            mkdir(paths.artifactRoot, { recursive: true }),
          ]);
        }).pipe(Effect.mapError(failWith(spec.bountyId, "start", "could not create the bounty root")));

        const running = yield* liveMachine(spec.bountyId, paths);
        if (running !== undefined) {
          yield* Effect.logInfo("local Swordfish daemon already running").pipe(
            Effect.annotateLogs("bounty_id", spec.bountyId),
            Effect.annotateLogs("vm_id", running.vmId),
            Effect.annotateLogs("pid", String(running.pid)),
          );
          return paths;
        }

        yield* cloneRepository(spec, paths);
        // Only one daemon may hold a bounty's SQLite authority, so a lost race here ends with
        // the loser refusing to start rather than with two daemons ("Swordfish authority is
        // locked to its database" (ADR 0027)). This check is what keeps that from being the
        // ordinary path, not what makes it safe.
        const pid = yield* runner
          .spawnDetached({
            command: ["bun", settings.swordfishEntrypoint],
            env: daemonEnvironment(spec, paths, settings),
            logPath: paths.logPath,
          })
          .pipe(Effect.mapError(failWith(spec.bountyId, "start", "could not start the daemon process")));
        // Asking the operating system for the start time rather than taking our own clock: the
        // record has to hold what a later `identify` will compare against, and only the kernel
        // knows that value.
        const started = yield* runner.identify(pid);
        if (started === undefined) {
          return yield* Effect.fail(
            new LocalDaemonError({
              bountyId: spec.bountyId,
              operation: "start",
              reason: "the daemon process exited before it could be recorded",
            }),
          );
        }
        const record: LocalMachineRecord = { vmId: spec.vmId, pid, startedAt: started.startedAt };
        yield* Effect.tryPromise(() =>
          writeFile(paths.machinePath, `${JSON.stringify(encodeMachineRecord(record))}\n`, { mode: 0o600 }),
        ).pipe(Effect.mapError(failWith(spec.bountyId, "start", "could not record the daemon")));
        yield* Effect.logInfo("started local Swordfish daemon").pipe(
          Effect.annotateLogs("bounty_id", spec.bountyId),
          Effect.annotateLogs("vm_id", spec.vmId),
          Effect.annotateLogs("pid", String(pid)),
        );
        return paths;
      });

    const stop = (bountyId: BountyId) =>
      Effect.gen(function* () {
        const paths = localBountyPaths(settings.root, bountyId);
        const machine = yield* liveMachine(bountyId, paths);
        if (machine === undefined) {
          // Either never started, already gone, or a record whose pid is now someone else's.
          // Clear it either way: what it names is not this bounty's machine.
          yield* Effect.promise(() => rm(paths.machinePath, { force: true }));
          return;
        }
        yield* runner.signal(machine.pid, "SIGTERM");
        // The daemon drains its outbox and releases its authority lock on SIGTERM, so it is
        // given the time to do that before it is killed; a killed daemon leaves a lock a
        // later provision would have to break.
        const polls = Math.max(
          1,
          Math.ceil(Duration.toMillis(settings.stopGracePeriod) / Duration.toMillis(stopPollInterval)),
        );
        let exited = false;
        for (let poll = 0; poll < polls && !exited; poll += 1) {
          yield* Effect.sleep(stopPollInterval);
          // Identity again rather than liveness: the pid becoming someone else's process is the
          // daemon having exited, not the daemon still running.
          const actual = yield* runner.identify(machine.pid);
          exited = actual === undefined || actual.startedAt !== machine.startedAt;
        }
        if (!exited) {
          yield* Effect.logWarning("local Swordfish daemon did not exit; killing").pipe(
            Effect.annotateLogs("bounty_id", bountyId),
            Effect.annotateLogs("vm_id", machine.vmId),
            Effect.annotateLogs("pid", String(machine.pid)),
          );
          yield* runner.signal(machine.pid, "SIGKILL");
        }
        yield* Effect.promise(() => rm(paths.machinePath, { force: true }));
        yield* Effect.logInfo("stopped local Swordfish daemon").pipe(
          Effect.annotateLogs("bounty_id", bountyId),
          Effect.annotateLogs("vm_id", machine.vmId),
          Effect.annotateLogs("pid", String(machine.pid)),
        );
      });

    return { ensureRunning, stop };
  });

/** The same supervisor as a layer, for tests that build it into a context. */
export const LocalSwordfishSupervisorLayer = (
  settings: LocalDaemonSettings,
): Layer.Layer<LocalSwordfishSupervisor, never, LocalProcessRunner> =>
  Layer.effect(LocalSwordfishSupervisor)(makeLocalSwordfishSupervisor(settings));
