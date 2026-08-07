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
          // A bare environment: the daemon gets exactly what bebop injects plus what a process
          // cannot run without, so nothing leaks in from the operator's shell by accident.
          env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
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

  // Signal 0 performs the permission and existence check without delivering anything, which is
  // the only way to ask about a process this one does not own.
  isAlive: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),

  signal: (pid, signal) =>
    Effect.sync(() => {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone. The caller is polling liveness, so it learns that on the next poll.
      }
    }),

  run: ({ command }) =>
    Effect.tryPromise(async () => {
      const [executable, ...args] = command;
      if (executable === undefined) throw new Error("a command needs an executable");
      const result = Bun.spawnSync([executable, ...args], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) {
        const output = new TextDecoder().decode(result.stderr).trim();
        throw new Error(`${executable} exited ${result.exitCode}: ${output}`);
      }
    }),
}));
