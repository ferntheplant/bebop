import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function waitForSocket(path: string, daemon: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error("packed daemon exited before creating its control socket");
    try {
      if ((await lstat(path)).isSocket()) return;
    } catch {
      // The daemon is still applying its bundled migration.
    }
    await Bun.sleep(25);
  }
  throw new Error(`packed daemon did not create ${path}`);
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
  await waitForSocket(socketPath, daemon);
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
