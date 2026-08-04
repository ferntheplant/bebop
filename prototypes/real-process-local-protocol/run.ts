// PROTOTYPE ONLY.
//
// This driver answers one question: whether the real packed Bebop and Swordfish programs
// compose over their production HTTP, WebSocket, Unix-socket, Postgres, and SQLite seams.
// It does not inject workflow events or pretend the missing OpenCode driver exists.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const repositoryRoot = resolve(here, "../..");
const scratch = join(here, ".prototype");
const logsRoot = join(scratch, "logs");
const composeFile = join(here, "compose.yml");
const bebopApiEntrypoint = join(repositoryRoot, "apps/bebop/dist/api.mjs");
const bebopWorkerEntrypoint = join(repositoryRoot, "apps/bebop/dist/worker.mjs");
const bebopCliEntrypoint = join(repositoryRoot, "apps/bebop/dist/cli.mjs");
const swordfishDaemonEntrypoint = join(repositoryRoot, "apps/swordfish/dist/daemon.mjs");
const sfCliEntrypoint = join(repositoryRoot, "apps/swordfish/dist/cli.mjs");

interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface RunningProcess {
  readonly name: string;
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly stop: (signal?: NodeJS.Signals) => Promise<void>;
}

interface ProbeResult {
  readonly id: string;
  readonly question: string;
  readonly pass: boolean;
  readonly observed: unknown;
}

interface BountyDetail {
  readonly bountyId: string;
  readonly repository: string;
  readonly assignedBranch: string;
  readonly status: string;
  readonly swordfishStage?: string;
  readonly swordfishFreshness: string;
}

interface SfStatus {
  readonly stage: string;
  readonly bebopConnection: {
    readonly state: string;
    readonly acknowledgedThrough: number;
    readonly pendingEventCount: number;
  };
  readonly recentEvents: ReadonlyArray<{
    readonly sequence: number;
    readonly event: { readonly type: string; readonly stage?: string };
  }>;
}

interface PublicEvent {
  readonly cursor: number;
  readonly event: {
    readonly type: string;
    readonly status?: string;
    readonly freshness?: string;
    readonly event?: { readonly type: string; readonly stage?: string };
  };
}

interface BountyFixture {
  readonly detail: BountyDetail;
  readonly root: string;
  readonly socketPath: string;
  readonly daemonEnv: Readonly<Record<string, string>>;
}

const results: Array<ProbeResult> = [];
const processes: Array<RunningProcess> = [];
let processOrdinal = 0;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown failure";
  }
}

async function probe<T>(
  id: string,
  question: string,
  body: () => Promise<{ readonly observed: T }>,
): Promise<T | undefined> {
  try {
    const { observed } = await body();
    results.push({ id, question, pass: true, observed });
    process.stdout.write(`  PASS  ${id.padEnd(4)} ${question}\n        ${JSON.stringify(observed)}\n`);
    return observed;
  } catch (error) {
    const observed = { error: error instanceof Error ? error.message : String(error) };
    results.push({ id, question, pass: false, observed });
    process.stdout.write(`  FAIL  ${id.padEnd(4)} ${question}\n        ${JSON.stringify(observed)}\n`);
    return undefined;
  }
}

function startProcess(name: string, entrypoint: string, env: Readonly<Record<string, string>>): RunningProcess {
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
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      await waitForExit(running, 5_000).catch(async (error: unknown) => {
        child.kill("SIGKILL");
        await waitForExit(running, 1_000).catch(() => undefined);
        throw error;
      });
    },
  };
  processes.push(running);
  return running;
}

function run(
  entrypoint: string,
  args: ReadonlyArray<string>,
  options?: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number },
): Promise<Outcome> {
  return new Promise((resolveRun) => {
    const child = spawn("bun", [entrypoint, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...options?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), options?.timeoutMs ?? 10_000);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, exitCode, signal });
    });
  });
}

async function waitForExit(processToWaitFor: RunningProcess, timeoutMs = 10_000): Promise<Outcome> {
  if (processToWaitFor.child.exitCode !== null || processToWaitFor.child.signalCode !== null) {
    return {
      stdout: processToWaitFor.output(),
      stderr: "",
      exitCode: processToWaitFor.child.exitCode,
      signal: processToWaitFor.child.signalCode,
    };
  }
  return await new Promise<Outcome>((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${processToWaitFor.name} did not exit:\n${processToWaitFor.output()}`)),
      timeoutMs,
    );
    processToWaitFor.child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveExit({ stdout: processToWaitFor.output(), stderr: "", exitCode, signal });
    });
  });
}

async function waitFor<T>(description: string, read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
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

async function availablePort(): Promise<number> {
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

async function compose(...args: ReadonlyArray<string>): Promise<string> {
  const child = spawn("docker", ["compose", "-f", composeFile, ...args], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const read = (stream: NodeJS.ReadableStream) =>
    new Promise<string>((resolveRead, reject) => {
      let text = "";
      stream.on("data", (chunk: Buffer) => (text += chunk.toString()));
      stream.once("end", () => resolveRead(text));
      stream.once("error", reject);
    });
  const [stdout, stderr, exitCode] = await Promise.all([
    read(child.stdout),
    read(child.stderr),
    new Promise<number | null>((resolveExit) => child.once("close", resolveExit)),
  ]);
  if (exitCode !== 0) throw new Error(`docker compose ${args.join(" ")} failed (${exitCode}):\n${stderr}`);
  return stdout.trim();
}

async function requestJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}: ${text}`);
  return text.length === 0 ? (undefined as T) : (JSON.parse(text) as T);
}

async function waitForHealth(baseUrl: string): Promise<void> {
  await waitFor("Bebop health", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    return response.ok ? true : undefined;
  });
}

async function createBounty(
  baseUrl: string,
  apiToken: string,
  idempotencyKey: string,
  label: string,
): Promise<BountyDetail> {
  const outcome = await run(bebopCliEntrypoint, [
    "bounty",
    "create",
    "--repository",
    "withco/bebop",
    "--base-ref",
    "main",
    "--compute-profile",
    "small",
    "--idempotency-key",
    idempotencyKey,
    "--url",
    baseUrl,
    "--token",
    apiToken,
    "--json",
  ]);
  assert(outcome.exitCode === 0, `${label} create failed: ${outcome.stderr}${outcome.stdout}`);
  return JSON.parse(outcome.stdout) as BountyDetail;
}

async function bebopStatus(baseUrl: string, apiToken: string, bountyId: string): Promise<BountyDetail> {
  const outcome = await run(bebopCliEntrypoint, [
    "bounty",
    "status",
    "--bounty",
    bountyId,
    "--url",
    baseUrl,
    "--token",
    apiToken,
    "--json",
  ]);
  assert(outcome.exitCode === 0, `bebop status failed: ${outcome.stderr}${outcome.stdout}`);
  return JSON.parse(outcome.stdout) as BountyDetail;
}

async function sfStatus(socketPath: string): Promise<SfStatus> {
  const outcome = await run(sfCliEntrypoint, ["status", "--socket", socketPath, "--json"], { timeoutMs: 2_000 });
  assert(outcome.exitCode === 0, `sf status failed: ${outcome.stderr}${outcome.stdout}`);
  return JSON.parse(outcome.stdout) as SfStatus;
}

async function waitForSf(
  fixture: BountyFixture,
  description: string,
  predicate: (status: SfStatus) => boolean,
): Promise<SfStatus> {
  return await waitFor(description, async () => {
    const status = await sfStatus(fixture.socketPath);
    return predicate(status) ? status : undefined;
  });
}

async function replayPublicEvents(baseUrl: string, apiToken: string, bountyId: string): Promise<Array<PublicEvent>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  let text = "";
  try {
    const response = await fetch(`${baseUrl}/api/bounties/${bountyId}/events`, {
      headers: { authorization: `Bearer ${apiToken}` },
      signal: controller.signal,
    });
    assert(response.ok && response.body !== null, `event replay returned ${response.status}`);
    const reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value, { stream: true });
    }
  } catch (error) {
    // The production SSE route intentionally has no keepalive yet (issue 18). Depending on
    // whether our abort or Bun's idle close wins, fetch reports AbortError or a socket-close
    // TypeError. Once replay bytes arrived, either one is the expected end of this bounded read.
    if (text.length === 0 && !(error instanceof DOMException && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timeout);
  }
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) =>
      frame
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim(),
    )
    .filter((data): data is string => data !== undefined && data.length > 0)
    .map((data) => JSON.parse(data) as PublicEvent);
}

function workflowEventCounts(events: ReadonlyArray<PublicEvent>): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const envelope of events) {
    if (envelope.event.type !== "swordfish_event" || envelope.event.event === undefined) continue;
    const event = envelope.event.event;
    const key = event.type === "stage_changed" ? `${event.type}:${event.stage}` : event.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function swordfishToken(credentialKey: string, bountyId: string): string {
  const digest = createHmac("sha256", credentialKey).update(`bebop-swordfish:${bountyId}`).digest("base64url");
  return `bebop_sf_${digest}`;
}

async function makeBountyFixture(
  detail: BountyDetail,
  baseUrl: string,
  credentialKey: string,
  label: string,
): Promise<BountyFixture> {
  const root = join(scratch, label);
  const socketPath = join(root, "run", "control.sock");
  await Promise.all([
    mkdir(join(root, "run"), { recursive: true }),
    mkdir(join(root, "state"), { recursive: true }),
    mkdir(join(root, "repository"), { recursive: true }),
    mkdir(join(root, "artifacts"), { recursive: true }),
  ]);
  return {
    detail,
    root,
    socketPath,
    daemonEnv: {
      SWORDFISH_BOUNTY_ID: detail.bountyId,
      SWORDFISH_VM_ID: `vm-${detail.bountyId}`,
      SWORDFISH_REPOSITORY: detail.repository,
      SWORDFISH_ASSIGNED_BRANCH: detail.assignedBranch,
      SWORDFISH_BEBOP_WEB_SOCKET_URL: `${baseUrl.replace(/^http/, "ws")}/swordfish`,
      SWORDFISH_BEBOP_TOKEN: swordfishToken(credentialKey, detail.bountyId),
      SWORDFISH_DATABASE_PATH: join(root, "state", "swordfish.sqlite"),
      SWORDFISH_CONTROL_SOCKET_PATH: socketPath,
      SWORDFISH_REPOSITORY_PATH: join(root, "repository"),
      SWORDFISH_ARTIFACT_ROOT: join(root, "artifacts"),
      SWORDFISH_OPEN_CODE_BASE_URL: "http://127.0.0.1:4096/",
      SWORDFISH_HEARTBEAT_INTERVAL: "100 millis",
      SWORDFISH_RECONNECT_MINIMUM_DELAY: "50 millis",
      SWORDFISH_RECONNECT_MAXIMUM_DELAY: "500 millis",
      SWORDFISH_SHUTDOWN_TIMEOUT: "2 seconds",
    },
  };
}

async function waitForAttachment(baseUrl: string, apiToken: string, bountyId: string): Promise<unknown> {
  return await waitFor("fake lifecycle attachment", async () => {
    try {
      return await requestJson(`${baseUrl}/api/bounties/${bountyId}/attachments`, apiToken);
    } catch {
      return undefined;
    }
  });
}

async function saveProcessLogs(): Promise<void> {
  await mkdir(logsRoot, { recursive: true });
  await Promise.all(
    processes.map((processToSave) => writeFile(join(logsRoot, `${processToSave.name}.log`), processToSave.output())),
  );
}

await rm(scratch, { recursive: true, force: true });
await mkdir(logsRoot, { recursive: true });
await compose("down", "--volumes", "--remove-orphans").catch(() => undefined);

let postgresStarted = false;
let api: RunningProcess | undefined;

try {
  process.stdout.write("starting disposable Postgres...\n");
  await compose("up", "--detach", "--wait");
  postgresStarted = true;
  const mapping = await compose("port", "postgres", "5432");
  const postgresPort = Number(mapping.split(":").at(-1));
  assert(Number.isSafeInteger(postgresPort), `Could not read the Postgres port from ${mapping}.`);

  const apiPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const apiToken = "bebop_real-process-prototype-bootstrap";
  const credentialKey = "real-process-prototype-swordfish-key-at-least-32-bytes";
  const bebopEnv = {
    BEBOP_HOST: "127.0.0.1",
    BEBOP_PORT: String(apiPort),
    BEBOP_DATABASE_URL: `postgres://bebop:prototype-password@127.0.0.1:${postgresPort}/bebop_prototype`,
    BEBOP_PUBLIC_BASE_URL: "https://bebop.prototype.invalid/",
    BEBOP_ARTIFACT_ROOT: join(scratch, "bebop-artifacts"),
    BEBOP_HEARTBEAT_INTERVAL: "100 millis",
    BEBOP_SWORDFISH_STALE_AFTER: "500 millis",
    BEBOP_MAX_PROTOCOL_MESSAGE_BYTES: "262144",
    BEBOP_SHUTDOWN_TIMEOUT: "2 seconds",
    BEBOP_WORKER_POLL_INTERVAL: "50 millis",
    BEBOP_JOB_RETRY_DELAY: "20 millis",
    BEBOP_JOB_LEASE_DURATION: "2 seconds",
    BEBOP_EVENT_STREAM_POLL_INTERVAL: "50 millis",
    BEBOP_COMMAND_POLL_INTERVAL: "50 millis",
    BEBOP_HTTP_IDLE_TIMEOUT: "2 seconds",
    BEBOP_SWORDFISH_CREDENTIAL_KEY: credentialKey,
    BEBOP_BOOTSTRAP_API_TOKEN: apiToken,
  } as const;

  process.stdout.write("\npacked process seam\n");
  startProcess("bebop-worker", bebopWorkerEntrypoint, bebopEnv);
  await delay(100);
  api = startProcess("bebop-api", bebopApiEntrypoint, bebopEnv);
  await waitForHealth(baseUrl);

  let alpha = await createBounty(baseUrl, apiToken, "prototype-alpha", "alpha");
  const alphaAttachment = await waitForAttachment(baseUrl, apiToken, alpha.bountyId);
  const replayedAlpha = await createBounty(baseUrl, apiToken, "prototype-alpha", "alpha replay");
  assert(replayedAlpha.bountyId === alpha.bountyId, "A repeated idempotency key created a second bounty.");
  const alphaFixture = await makeBountyFixture(alpha, baseUrl, credentialKey, "alpha");
  let alphaDaemon = startProcess("swordfish-alpha", swordfishDaemonEntrypoint, alphaFixture.daemonEnv);

  await probe("RP1", "worker-first startup and all five packed entrypoints reach interactive", async () => {
    const sf = await waitForSf(
      alphaFixture,
      "alpha registration and acknowledgement",
      (status) =>
        status.stage === "interactive" &&
        status.bebopConnection.state === "connected" &&
        status.bebopConnection.acknowledgedThrough === 1 &&
        status.bebopConnection.pendingEventCount === 0,
    );
    const bebop = await waitFor("Bebop interactive projection", async () => {
      const status = await bebopStatus(baseUrl, apiToken, alpha.bountyId);
      return status.status === "interactive" && status.swordfishFreshness === "connected" ? status : undefined;
    });
    const events = await replayPublicEvents(baseUrl, apiToken, alpha.bountyId);
    const counts = workflowEventCounts(events);
    assert(counts["stage_changed:interactive"] === 1, "The interactive event was missing or duplicated.");
    return {
      observed: {
        bountyId: alpha.bountyId,
        attachment: alphaAttachment,
        idempotentCreateBountyId: replayedAlpha.bountyId,
        sf: { stage: sf.stage, ...sf.bebopConnection },
        bebop: { status: bebop.status, freshness: bebop.swordfishFreshness },
        workflowEventCounts: counts,
      },
    };
  });

  await probe("RP2", "API loss and restart reconnects without duplicate projection", async () => {
    await api?.stop();
    api = undefined;
    const disconnected = await waitForSf(
      alphaFixture,
      "Swordfish to notice API loss",
      (status) => status.bebopConnection.state === "disconnected",
    );
    api = startProcess("bebop-api", bebopApiEntrypoint, bebopEnv);
    await waitForHealth(baseUrl);
    const reconnected = await waitForSf(
      alphaFixture,
      "Swordfish to reconnect after API restart",
      (status) =>
        status.bebopConnection.state === "connected" &&
        status.bebopConnection.acknowledgedThrough === 1 &&
        status.bebopConnection.pendingEventCount === 0,
    );
    const events = await replayPublicEvents(baseUrl, apiToken, alpha.bountyId);
    const counts = workflowEventCounts(events);
    assert(counts["stage_changed:interactive"] === 1, "API restart duplicated the interactive projection.");
    return { observed: { before: disconnected.bebopConnection, after: reconnected.bebopConnection, counts } };
  });

  await probe("RP3", "SIGKILLed Swordfish restarts from SQLite without duplicate replay", async () => {
    await alphaDaemon.stop("SIGKILL");
    const unavailable = await waitFor("Bebop to observe daemon loss", async () => {
      const status = await bebopStatus(baseUrl, apiToken, alpha.bountyId);
      return status.swordfishFreshness === "disconnected" || status.swordfishFreshness === "stale" ? status : undefined;
    });
    alphaDaemon = startProcess("swordfish-alpha", swordfishDaemonEntrypoint, alphaFixture.daemonEnv);
    const restored = await waitForSf(
      alphaFixture,
      "alpha daemon restart",
      (status) =>
        status.stage === "interactive" &&
        status.bebopConnection.state === "connected" &&
        status.bebopConnection.acknowledgedThrough === 1 &&
        status.bebopConnection.pendingEventCount === 0,
    );
    const events = await replayPublicEvents(baseUrl, apiToken, alpha.bountyId);
    const counts = workflowEventCounts(events);
    assert(counts["stage_changed:interactive"] === 1, "Daemon restart duplicated the interactive projection.");
    return {
      observed: {
        lossFreshness: unavailable.swordfishFreshness,
        restored: restored.bebopConnection,
        workflowEventCounts: counts,
      },
    };
  });

  await probe("RP4", "local sf cancel projects cancellation while Swordfish remains available", async () => {
    const cancelled = await run(sfCliEntrypoint, ["cancel", "--socket", alphaFixture.socketPath, "--json"]);
    assert(cancelled.exitCode === 0, `sf cancel failed: ${cancelled.stderr}${cancelled.stdout}`);
    const local = JSON.parse(cancelled.stdout) as SfStatus;
    assert(local.stage === "cancelled", `sf cancel returned ${local.stage}, not cancelled.`);
    const delivered = await waitForSf(
      alphaFixture,
      "cancelled event delivery",
      (status) =>
        status.stage === "cancelled" &&
        status.bebopConnection.state === "connected" &&
        status.bebopConnection.acknowledgedThrough === 3 &&
        status.bebopConnection.pendingEventCount === 0,
    );
    const projected = await waitFor("Bebop cancelled projection", async () => {
      const status = await bebopStatus(baseUrl, apiToken, alpha.bountyId);
      return status.swordfishStage === "cancelled" ? status : undefined;
    });
    const events = await replayPublicEvents(baseUrl, apiToken, alpha.bountyId);
    const counts = workflowEventCounts(events);
    assert(counts["stage_changed:interactive"] === 1, "Interactive was duplicated during cancellation replay.");
    assert(counts["stage_changed:cancelling"] === 1, "Cancelling was missing or duplicated.");
    assert(counts["stage_changed:cancelled"] === 1, "Cancelled was missing or duplicated.");
    return {
      observed: {
        daemonRemainedAlive: alphaDaemon.child.exitCode === null,
        delivered: delivered.bebopConnection,
        projectedStatus: projected.status,
        workflowEventCounts: counts,
      },
    };
  });

  process.stdout.write("\nlistener-first and offline command seam\n");
  const beta = await createBounty(baseUrl, apiToken, "prototype-beta", "beta");
  await waitForAttachment(baseUrl, apiToken, beta.bountyId);
  const betaFixture = await makeBountyFixture(beta, baseUrl, credentialKey, "beta");
  await api.stop();
  api = undefined;
  let betaDaemon = startProcess("swordfish-beta", swordfishDaemonEntrypoint, betaFixture.daemonEnv);

  await probe("RP5", "Swordfish started without a listener reconnects and registers later", async () => {
    const offline = await waitForSf(
      betaFixture,
      "beta local bootstrap while API is absent",
      (status) =>
        status.stage === "interactive" &&
        status.bebopConnection.state === "disconnected" &&
        status.bebopConnection.pendingEventCount === 1,
    );
    api = startProcess("bebop-api", bebopApiEntrypoint, bebopEnv);
    await waitForHealth(baseUrl);
    const online = await waitForSf(
      betaFixture,
      "beta delayed registration",
      (status) =>
        status.bebopConnection.state === "connected" &&
        status.bebopConnection.acknowledgedThrough === 1 &&
        status.bebopConnection.pendingEventCount === 0,
    );
    const projected = await waitFor("beta interactive projection", async () => {
      const status = await bebopStatus(baseUrl, apiToken, beta.bountyId);
      return status.status === "interactive" ? status : undefined;
    });
    return {
      observed: {
        beforeListener: offline.bebopConnection,
        afterListener: online.bebopConnection,
        projectedStatus: projected.status,
      },
    };
  });

  await probe("RP6", "an offline Bebop stop is delivered once and acknowledged across restart", async () => {
    await betaDaemon.stop("SIGKILL");
    await waitFor("beta daemon loss", async () => {
      const status = await bebopStatus(baseUrl, apiToken, beta.bountyId);
      return status.swordfishFreshness === "disconnected" || status.swordfishFreshness === "stale" ? true : undefined;
    });
    const accepted = await requestJson<BountyDetail>(`${baseUrl}/api/bounties/${beta.bountyId}/stop`, apiToken, {
      method: "POST",
      body: JSON.stringify({ reason: "real-process prototype offline stop" }),
    });
    assert(accepted.status === "stopped", `Bebop stop returned ${accepted.status}.`);

    betaDaemon = startProcess("swordfish-beta", swordfishDaemonEntrypoint, betaFixture.daemonEnv);
    const firstExit = await waitForExit(betaDaemon);
    assert(firstExit.exitCode === 0, `The delivered stop exited with ${firstExit.exitCode ?? firstExit.signal}.`);

    betaDaemon = startProcess("swordfish-beta", swordfishDaemonEntrypoint, betaFixture.daemonEnv);
    const restarted = await waitForSf(
      betaFixture,
      "beta restart after completed stop",
      (status) => status.stage === "cancelled" && status.bebopConnection.state === "connected",
    );
    await delay(1_000);
    assert(
      betaDaemon.child.exitCode === null && betaDaemon.child.signalCode === null,
      "The completed stop command was redelivered and stopped the daemon again.",
    );
    const settled = await waitForSf(
      betaFixture,
      "beta cancellation acknowledgements",
      (status) => status.bebopConnection.acknowledgedThrough === 3 && status.bebopConnection.pendingEventCount === 0,
    );
    const events = await replayPublicEvents(baseUrl, apiToken, beta.bountyId);
    const counts = workflowEventCounts(events);
    assert(counts["stage_changed:interactive"] === 1, "Offline stop replay duplicated interactive.");
    assert(counts["stage_changed:cancelling"] === 1, "Offline stop did not project cancelling exactly once.");
    assert(counts["stage_changed:cancelled"] === 1, "Offline stop did not project cancelled exactly once.");
    return {
      observed: {
        acceptedStatus: accepted.status,
        firstExit: { exitCode: firstExit.exitCode, signal: firstExit.signal },
        secondStartAlive: betaDaemon.child.exitCode === null,
        firstRestartStatus: restarted.bebopConnection,
        settled: settled.bebopConnection,
        workflowEventCounts: counts,
      },
    };
  });

  alpha = await bebopStatus(baseUrl, apiToken, alpha.bountyId);
  const failed = results.filter((result) => !result.pass);
  await writeFile(
    join(here, "results.json"),
    `${JSON.stringify({ completedAt: new Date().toISOString(), alpha, results }, null, 2)}\n`,
  );
  process.stdout.write(`\n${results.length - failed.length}/${results.length} probes passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((result) => result.id).join(", ")}\n`);
    process.exitCode = 1;
  }
} finally {
  await Promise.all(processes.map((processToStop) => processToStop.stop().catch(() => undefined)));
  await saveProcessLogs().catch(() => undefined);
  if (postgresStarted) {
    process.stdout.write("stopping disposable Postgres...\n");
    await compose("down", "--volumes", "--remove-orphans").catch((error: unknown) => {
      process.stdout.write(`warning: Postgres teardown failed: ${String(error)}\n`);
    });
  }
}
