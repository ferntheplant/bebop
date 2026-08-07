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
// Two services rather than one: `LocalProcessRunner` is the narrow seam that actually touches
// processes and the filesystem, and the supervisor holds the decisions — where a bounty's
// directories go, whether a recorded process is still alive, and how a stop escalates. Tests
// replace the runner and exercise the decisions without spawning anything, which is the split
// the architectural rule on process execution asks for.

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BountyId, GitRef, RepositorySlug } from "@bebop/contracts";
import { Context, Data, Effect, Layer } from "effect";

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
 * The credentials travel in memory from derivation into the spawned process's environment and
 * are never written to disk — the injection "Swordfish tokens are bounty-scoped, minted at
 * provisioning, and never rotate" (ADR 0014) describes, at a seam where the VM is a directory.
 */
export interface LocalDaemonSpec {
  readonly bountyId: BountyId;
  readonly vmId: string;
  readonly repository: RepositorySlug;
  readonly assignedBranch: GitRef;
  readonly swordfishToken: string;
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
  readonly pidPath: string;
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
    pidPath: join(bountyRoot, "run", "daemon.pid"),
  };
}

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
  /** The daemon cadences a VM bootstrap would set, as Effect duration strings. */
  readonly heartbeatInterval: string;
  readonly reconnectMinimumDelay: string;
  readonly reconnectMaximumDelay: string;
  readonly shutdownTimeout: string;
  /**
   * How long a stop waits for a signalled daemon before killing it.
   *
   * It is a setting rather than a constant because it is the one number in here a test has to
   * move: the escalation path is only reachable by waiting the period out.
   */
  readonly stopGracePeriodMillis: number;
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
  /** Whether a pid names a process that is still running. */
  readonly isAlive: (pid: number) => Effect.Effect<boolean>;
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
   * Idempotent per bounty because the worker retries provisioning after a crash: a live
   * recorded process is left strictly alone, and only a stale record is replaced.
   */
  readonly ensureRunning: (spec: LocalDaemonSpec) => Effect.Effect<LocalBountyPaths, LocalDaemonError>;
  /** Stops a bounty's daemon. Stopping one that is not running succeeds. */
  readonly stop: (bountyId: BountyId) => Effect.Effect<void, LocalDaemonError>;
}

export class LocalSwordfishSupervisor extends Context.Service<
  LocalSwordfishSupervisor,
  LocalSwordfishSupervisorService
>()("LocalSwordfishSupervisor") {}

/** The default a local runtime uses: long enough for an outbox drain, short enough to not hang a destroy. */
export const defaultStopGracePeriodMillis = 10_000;
const stopPollIntervalMillis = 20;

function daemonEnvironment(
  spec: LocalDaemonSpec,
  paths: LocalBountyPaths,
  settings: LocalDaemonSettings,
): Record<string, string> {
  return {
    SWORDFISH_BOUNTY_ID: spec.bountyId,
    SWORDFISH_VM_ID: spec.vmId,
    SWORDFISH_REPOSITORY: spec.repository,
    SWORDFISH_ASSIGNED_BRANCH: spec.assignedBranch,
    SWORDFISH_BEBOP_WEB_SOCKET_URL: settings.bebopWebSocketUrl,
    SWORDFISH_BEBOP_TOKEN: spec.swordfishToken,
    SWORDFISH_DATABASE_PATH: paths.databasePath,
    SWORDFISH_CONTROL_SOCKET_PATH: paths.controlSocketPath,
    SWORDFISH_REPOSITORY_PATH: paths.repositoryPath,
    SWORDFISH_ARTIFACT_ROOT: paths.artifactRoot,
    SWORDFISH_OPEN_CODE_BASE_URL: settings.openCodeBaseUrl,
    SWORDFISH_OPERATOR_CREDENTIAL_VERIFIER: spec.operatorCredentialVerifier,
    // The daemon's cadences are required configuration with no defaults of their own, because a
    // VM's bootstrap is what supplies them in production. Locally this is that bootstrap, so it
    // supplies them here — and the reconnect bounds are what the backoff in `sf status` runs
    // between ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)).
    SWORDFISH_HEARTBEAT_INTERVAL: settings.heartbeatInterval,
    SWORDFISH_RECONNECT_MINIMUM_DELAY: settings.reconnectMinimumDelay,
    SWORDFISH_RECONNECT_MAXIMUM_DELAY: settings.reconnectMaximumDelay,
    SWORDFISH_SHUTDOWN_TIMEOUT: settings.shutdownTimeout,
  };
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

    const recordedPid = (paths: LocalBountyPaths) =>
      Effect.tryPromise(() => readFile(paths.pidPath, "utf8")).pipe(
        Effect.map((text) => {
          const pid = Number.parseInt(text.trim(), 10);
          return Number.isInteger(pid) && pid > 0 ? pid : undefined;
        }),
        // No pid file, or an unreadable one, both mean the same thing: nothing to reattach to.
        Effect.orElseSucceed(() => undefined),
      );

    const livePid = (paths: LocalBountyPaths) =>
      Effect.gen(function* () {
        const pid = yield* recordedPid(paths);
        if (pid === undefined) return undefined;
        return (yield* runner.isAlive(pid)) ? pid : undefined;
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

        const running = yield* livePid(paths);
        if (running !== undefined) {
          yield* Effect.logInfo("local Swordfish daemon already running").pipe(
            Effect.annotateLogs("bounty_id", spec.bountyId),
            Effect.annotateLogs("pid", String(running)),
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
        yield* Effect.tryPromise(() => writeFile(paths.pidPath, `${pid}\n`, { mode: 0o600 })).pipe(
          Effect.mapError(failWith(spec.bountyId, "start", "could not record the daemon pid")),
        );
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
        const pid = yield* livePid(paths);
        if (pid === undefined) {
          // Either never started or already gone. Clear the record either way so a later
          // provision does not reattach to a pid the operating system has since reused.
          yield* Effect.promise(() => rm(paths.pidPath, { force: true }));
          return;
        }
        yield* runner.signal(pid, "SIGTERM");
        // The daemon drains its outbox and releases its authority lock on SIGTERM, so it is
        // given the time to do that before it is killed; a killed daemon leaves a lock a
        // later provision would have to break.
        const polls = Math.max(1, Math.ceil(settings.stopGracePeriodMillis / stopPollIntervalMillis));
        let exited = false;
        for (let poll = 0; poll < polls && !exited; poll += 1) {
          yield* Effect.sleep(`${stopPollIntervalMillis} millis`);
          exited = !(yield* runner.isAlive(pid));
        }
        if (!exited) {
          yield* Effect.logWarning("local Swordfish daemon did not exit; killing").pipe(
            Effect.annotateLogs("bounty_id", bountyId),
            Effect.annotateLogs("pid", String(pid)),
          );
          yield* runner.signal(pid, "SIGKILL");
        }
        yield* Effect.promise(() => rm(paths.pidPath, { force: true }));
        yield* Effect.logInfo("stopped local Swordfish daemon").pipe(
          Effect.annotateLogs("bounty_id", bountyId),
          Effect.annotateLogs("pid", String(pid)),
        );
      });

    return { ensureRunning, stop };
  });

/** The same supervisor as a layer, for tests that build it into a context. */
export const LocalSwordfishSupervisorLayer = (
  settings: LocalDaemonSettings,
): Layer.Layer<LocalSwordfishSupervisor, never, LocalProcessRunner> =>
  Layer.effect(LocalSwordfishSupervisor)(makeLocalSwordfishSupervisor(settings));
