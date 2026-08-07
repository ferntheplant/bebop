// The one place bebop touches operating-system processes.
//
// It is kept apart from the supervisor that calls it so the decisions — reattach or spawn, how a
// stop escalates — are tested against a substituted runner, and only this file needs a real
// process to exercise. That split is the architectural rule on process execution being an Effect
// service, applied where it earns its keep.

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

import { Effect, Layer } from "effect";

import { LocalProcessRunner } from "#src/lifecycle/local-daemon.ts";

/**
 * What a local machine inherits from the operator's shell.
 *
 * "The local loop runs the production assembly" (ADR 0046) settles that the machine works
 * GitHub through the operator's ambient `git` and `gh` credentials, which is structurally what
 * exe.dev's repository-scoped integration provides — so the daemon has to reach them, and a
 * bare `PATH`/`HOME` environment leaves it unable to authenticate at all. The failure is
 * invisible until the daemon tries, deep inside a bounty rather than at startup.
 *
 * An allowlist rather than the inverse. Passing everything except bebop's own variables would
 * hand `BEBOP_DATABASE_URL` and `BEBOP_SWORDFISH_CREDENTIAL_KEY` to Swordfish the moment
 * someone adds a variable the deny-list has not heard of, and Swordfish reaching bebop's state
 * anywhere but through the wire protocol is the seam ADR 0046 says local mode cannot enforce
 * and must not violate. This fails closed instead: a credential we forgot means a daemon that
 * cannot authenticate, not a daemon holding bebop's database.
 */
const inheritedVariables = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  // The ssh-agent socket, and where `git` and `gh` keep their configuration and tokens.
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
];
/** `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_CONFIG_*` and the rest, as one rule rather than a list. */
const inheritedPrefix = "GIT_";

function ambientEnvironment(): Record<string, string> {
  const ambient: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (inheritedVariables.includes(name) || name.startsWith(inheritedPrefix)) ambient[name] = value;
  }
  return ambient;
}

export const LocalProcessRunnerLayer: Layer.Layer<LocalProcessRunner> = Layer.sync(LocalProcessRunner)(() => ({
  spawnDetached: ({ command, env, logPath }) =>
    Effect.tryPromise(async () => {
      const [executable, ...args] = command;
      if (executable === undefined) throw new Error("a command needs an executable");
      // Appending through a file descriptor rather than a pipe is what lets the child outlive
      // this process: a pipe dies with its reader, and the operator still needs the log.
      const log = await open(logPath, "a", 0o600);
      try {
        const child = spawn(executable, args, {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: { ...ambientEnvironment(), ...env },
        });
        // Without `unref` the parent's event loop keeps the child tethered and a worker exit
        // would wait on a daemon that is meant to outlast it.
        child.unref();
        const pid = child.pid;
        if (pid === undefined) throw new Error(`${executable} did not report a pid`);
        return pid;
      } finally {
        await log.close();
      }
    }),

  // `lstart` is the kernel's start time for the process, which is what turns a recycled pid into
  // a record that no longer matches rather than a stranger to reattach to or signal. `ps` exits
  // non-zero when nothing holds the pid, which is the only "is it there" question left.
  identify: (pid) =>
    Effect.sync(() => {
      // `LC_ALL=C` pins the locale so `lstart` renders identically on every host: the C
      // locale always prints `DDD MMM  D HH:MM:SS YYYY`, where the day field can pad with a
      // space (`Thu Aug  6 ...`). Splitting on runs of whitespace — not single spaces — is what
      // handles that pad, and the fixed five-token count is what lets one `ps` call separate a
      // start time from whatever command line follows it.
      const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart=,command="], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...ambientEnvironment(), LC_ALL: "C" },
      });
      if (result.exitCode !== 0) return undefined;
      const line = new TextDecoder().decode(result.stdout).trim();
      const tokens = line.split(/\s+/);
      if (tokens.length < 5) return undefined;
      return { startedAt: tokens.slice(0, 5).join(" "), command: tokens.slice(5).join(" ") };
    }),

  signal: (pid, signal) =>
    Effect.sync(() => {
      try {
        process.kill(pid, signal);
      } catch (error) {
        // `ESRCH` is the pid being gone — the caller re-identifies the pid and learns that on
        // the next poll, so it is the only signal-miss worth swallowing. Anything else (`EPERM`,
        // a live process we may not signal) is a defect rather than a signal that missed: a
        // stop that hid it would clear the record while the daemon is still running, so it is
        // left to crash — "defects remain crashes" — rather than be made invisible.
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
    }),

  run: ({ command }) =>
    Effect.tryPromise(async () => {
      const [executable, ...args] = command;
      if (executable === undefined) throw new Error("a command needs an executable");
      // The clone runs as the operator, with the same ambient credentials the daemon gets: it
      // is the same GitHub identity doing the same work one step earlier.
      const result = Bun.spawnSync([executable, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: ambientEnvironment(),
      });
      if (result.exitCode !== 0) {
        const output = new TextDecoder().decode(result.stderr).trim();
        throw new Error(`${executable} exited ${result.exitCode}: ${output}`);
      }
    }),
}));
