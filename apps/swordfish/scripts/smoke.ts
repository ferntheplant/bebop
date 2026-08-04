import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForSwordfishControl } from "@bebop/testkit";

const workspace = join(import.meta.dir, "..");
const daemonEntrypoint = join(workspace, "dist", "daemon.mjs");
const cliEntrypoint = join(workspace, "dist", "cli.mjs");

async function run(
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn(["bun", cliEntrypoint, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Waits until the daemon answers, not until its socket file appears.
 *
 * The file appears in `makeControlSocket`, which runs before the bundled migration and before
 * `runControlServer` is forked, so the socket accepts connections and parks them for the whole
 * of startup. Waiting on the file and then immediately running `sf status` sent that first real
 * request into the parked window and left it racing the CLI's own 5s response timeout — which a
 * loaded runner is entirely capable of winning.
 */
async function waitForDaemon(path: string, daemon: ReturnType<typeof Bun.spawn>): Promise<void> {
  await waitForSwordfishControl({
    path,
    timeoutMillis: 30_000,
    isRunning: () => daemon.exitCode === null && daemon.signalCode === null,
  });
}

const root = await mkdtemp(join(tmpdir(), "bebop-swordfish-smoke-"));
const socketPath = join(root, "run", "control.sock");
await Promise.all(
  ["run", "state", "repository", "artifacts"].map((directory) => mkdir(join(root, directory), { recursive: true })),
);
const env = {
  SWORDFISH_BOUNTY_ID: "bty-smoke",
  SWORDFISH_VM_ID: "vm-smoke",
  SWORDFISH_REPOSITORY: "withco/bebop",
  SWORDFISH_ASSIGNED_BRANCH: "bounty/bty-smoke",
  SWORDFISH_BEBOP_WEB_SOCKET_URL: "ws://127.0.0.1:1/swordfish",
  SWORDFISH_BEBOP_TOKEN: "smoke-token",
  SWORDFISH_DATABASE_PATH: join(root, "state", "swordfish.sqlite"),
  SWORDFISH_CONTROL_SOCKET_PATH: socketPath,
  SWORDFISH_REPOSITORY_PATH: join(root, "repository"),
  SWORDFISH_ARTIFACT_ROOT: join(root, "artifacts"),
  SWORDFISH_OPEN_CODE_BASE_URL: "http://127.0.0.1:4096/",
  SWORDFISH_HEARTBEAT_INTERVAL: "100 millis",
  SWORDFISH_RECONNECT_MINIMUM_DELAY: "20 millis",
  SWORDFISH_RECONNECT_MAXIMUM_DELAY: "100 millis",
  SWORDFISH_SHUTDOWN_TIMEOUT: "1 second",
} as const;

const daemon = Bun.spawn(["bun", daemonEntrypoint], {
  env: { ...process.env, ...env },
  stdout: "pipe",
  stderr: "pipe",
});
try {
  await waitForDaemon(socketPath, daemon);
  const status = await run(["status", "--socket", socketPath, "--json"], env);
  if (status.code !== 0) throw new Error(`packed sf status failed: ${status.stderr}`);
  const snapshot = JSON.parse(status.stdout) as { stage?: unknown; bebopConnection?: { pendingEventCount?: unknown } };
  if (snapshot.stage !== "interactive" || snapshot.bebopConnection?.pendingEventCount !== 1) {
    throw new Error(`packed daemon returned an unexpected status: ${status.stdout}`);
  }
  const cancel = await run(["cancel", "--socket", socketPath], env);
  if (cancel.code !== 0) throw new Error(`packed sf cancel failed: ${cancel.stderr}`);
  const cancelled = await run(["status", "--socket", socketPath, "--json"], env);
  if (cancelled.code !== 0 || (JSON.parse(cancelled.stdout) as { stage?: unknown }).stage !== "cancelled") {
    throw new Error(`packed daemon was unavailable after sf cancel: ${cancelled.stderr}${cancelled.stdout}`);
  }
} finally {
  if (daemon.exitCode === null) {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
  await rm(root, { recursive: true, force: true });
}
