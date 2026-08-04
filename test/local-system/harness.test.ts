// The maintained local system harness (`.scratch/local-system-harness/brief.md`).
//
// It runs the packed Bebop API, worker, CLI, Swordfish daemon, and `sf` CLI over loopback
// with disposable Postgres and per-bounty SQLite/socket/artifact roots, and keeps the
// packed-process protocol floor the throwaway probe proved
// (`prototypes/real-process-local-protocol`) maintained. The machine credential travels only
// from Bebop's derivation through `LifecycleProvider.provision` into the one-shot bootstrap
// artifact, which the supervisor consumes to start Swordfish and then destroys — never
// through an operator retrieval route.
//
// Like every Postgres-backed suite, it requires `BEBOP_TEST_DATABASE_URL` and otherwise skips.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { DisposableDatabase } from "@bebop/testkit";
import { adminDatabaseUrl, createDisposableDatabase } from "@bebop/testkit";
import { describe, expect, test } from "vite-plus/test";

import {
  assert,
  availablePort,
  bootstrapArtifactExists,
  consumeBootstrapArtifact,
  delay,
  makeFleet,
  readBootstrapArtifact,
  repositoryRoot,
  waitFor,
  type LocalFleet,
  type RunningProcess,
} from "./support.ts";

const suite = adminDatabaseUrl() === null ? describe.skip : describe;

const credentialKey = "local-system-harness-credential-key-at-least-32-bytes";
const apiToken = "bebop_local-system-harness-bootstrap";

interface BebopEnv {
  readonly baseUrl: string;
  readonly env: Readonly<Record<string, string>>;
  readonly bootstrapRoot: string;
}

interface BountyFixture {
  readonly bountyId: string;
  readonly vmId: string;
  readonly root: string;
  readonly socketPath: string;
  readonly daemonEnv: Readonly<Record<string, string>>;
}

interface PublicEvent {
  readonly cursor: number;
  readonly event: {
    readonly type: string;
    readonly event?: { readonly type: string; readonly stage?: string };
  };
}

/** The Bebop process environment, shared by the API and the worker. */
function bebopEnvironment(options: {
  readonly apiPort: number;
  readonly databaseUrl: string;
  readonly fleetRoot: string;
  readonly bootstrapRoot: string;
}): Readonly<Record<string, string>> {
  return {
    BEBOP_HOST: "127.0.0.1",
    BEBOP_PORT: String(options.apiPort),
    BEBOP_DATABASE_URL: options.databaseUrl,
    BEBOP_PUBLIC_BASE_URL: "https://bebop.local-system.invalid/",
    BEBOP_ARTIFACT_ROOT: join(options.fleetRoot, "bebop-artifacts"),
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
    BEBOP_LOCAL_HARNESS_ROOT: options.bootstrapRoot,
  };
}

async function waitForHealth(baseUrl: string): Promise<void> {
  await waitFor("Bebop health", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    return response.ok ? true : undefined;
  });
}

function workflowEventCounts(events: ReadonlyArray<PublicEvent>): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const envelope of events) {
    if (envelope.event.type !== "swordfish_event" || envelope.event.event === undefined) continue;
    const event = envelope.event.event;
    const key = event.type === "stage_changed" ? `stage_changed:${event.stage}` : event.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function replayPublicEvents(baseUrl: string, bountyId: string): Promise<Array<PublicEvent>> {
  const controller = new AbortController();
  // The replay endpoint streams the backlog and then stays open for live events, so the read
  // is ended deliberately rather than by the server. The window only has to outlast the
  // backlog; `waitForWorkflowEventCount` is what absorbs a slow one.
  const timeout = setTimeout(() => controller.abort(), 2_000);
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

/**
 * Waits for a workflow event to reach an exact public count, then proves it stays there.
 *
 * Convergence and stability are different claims and this suite needs both: a slow stream
 * must not fail the run, and a replayed or double-projected event must not pass it. Asserting
 * a count once at a fixed moment gets this wrong in both directions.
 */
async function waitForWorkflowEventCount(
  baseUrl: string,
  bountyId: string,
  key: string,
  expected: number,
): Promise<void> {
  await waitFor(`${key} to reach ${expected} public event(s)`, async () => {
    const counts = workflowEventCounts(await replayPublicEvents(baseUrl, bountyId));
    return (counts[key] ?? 0) === expected ? true : undefined;
  });
  await delay(500);
  const settled = workflowEventCounts(await replayPublicEvents(baseUrl, bountyId));
  assert(
    (settled[key] ?? 0) === expected,
    `${key} settled at ${settled[key] ?? 0} public events, expected ${expected}`,
  );
}

async function createBounty(
  fleet: LocalFleet,
  bebop: BebopEnv,
  idempotencyKey: string,
): Promise<{ bountyId: string; repository: string; assignedBranch: string }> {
  const outcome = await fleet.run(
    join(repositoryRoot, "apps/bebop/dist/cli.mjs"),
    [
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
      bebop.baseUrl,
      "--token",
      apiToken,
      "--json",
    ],
    { timeoutMs: 15_000 },
  );
  assert(outcome.exitCode === 0, `bebop create failed: ${outcome.stderr}${outcome.stdout}`);
  return JSON.parse(outcome.stdout) as { bountyId: string; repository: string; assignedBranch: string };
}

async function bountyStatus(
  fleet: LocalFleet,
  bebop: BebopEnv,
  bountyId: string,
): Promise<{ status: string; swordfishStage?: string; swordfishFreshness: string }> {
  const outcome = await fleet.run(
    join(repositoryRoot, "apps/bebop/dist/cli.mjs"),
    ["bounty", "status", "--bounty", bountyId, "--url", bebop.baseUrl, "--token", apiToken, "--json"],
    { timeoutMs: 15_000 },
  );
  assert(outcome.exitCode === 0, `bebop status failed: ${outcome.stderr}${outcome.stdout}`);
  return JSON.parse(outcome.stdout) as { status: string; swordfishStage?: string; swordfishFreshness: string };
}

/** Drives `bebop bounty stop` through the packed CLI, which is its only automated coverage. */
async function stopBounty(
  fleet: LocalFleet,
  bebop: BebopEnv,
  bountyId: string,
  reason: string,
): Promise<{ status: string }> {
  const outcome = await fleet.run(
    join(repositoryRoot, "apps/bebop/dist/cli.mjs"),
    ["bounty", "stop", "--bounty", bountyId, "--reason", reason, "--url", bebop.baseUrl, "--token", apiToken, "--json"],
    { timeoutMs: 15_000 },
  );
  assert(outcome.exitCode === 0, `bebop stop failed: ${outcome.stderr}${outcome.stdout}`);
  return JSON.parse(outcome.stdout) as { status: string };
}

async function waitForAttachment(bebop: BebopEnv, bountyId: string): Promise<unknown> {
  return await waitFor("fake lifecycle attachment", async () => {
    try {
      const response = await fetch(`${bebop.baseUrl}/api/bounties/${bountyId}/attachments`, {
        headers: { authorization: `Bearer ${apiToken}` },
      });
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  });
}

interface SfStatus {
  readonly stage: string;
  readonly bebopConnection: {
    readonly state: string;
    readonly acknowledgedThrough: number;
    readonly pendingEventCount: number;
  };
}

async function sfStatus(fleet: LocalFleet, socketPath: string): Promise<SfStatus> {
  const outcome = await fleet.run(
    join(repositoryRoot, "apps/swordfish/dist/cli.mjs"),
    ["status", "--socket", socketPath, "--json"],
    { timeoutMs: 5_000 },
  );
  assert(outcome.exitCode === 0, `sf status failed: ${outcome.stderr}${outcome.stdout}`);
  return JSON.parse(outcome.stdout) as SfStatus;
}

async function waitForSf(
  fleet: LocalFleet,
  fixture: BountyFixture,
  description: string,
  predicate: (status: SfStatus) => boolean,
): Promise<SfStatus> {
  return await waitFor(description, async () => {
    const status = await sfStatus(fleet, fixture.socketPath);
    return predicate(status) ? status : undefined;
  });
}

/**
 * The local supervisor: consume the one-shot bootstrap artifact and turn it into the daemon
 * environment. After this returns, the plaintext machine credential exists only in the
 * environment of a process the fleet owns.
 */
async function superviseBounty(fleet: LocalFleet, bebop: BebopEnv, bountyId: string): Promise<BountyFixture> {
  const identity = await consumeBootstrapArtifact(bebop.bootstrapRoot, bountyId);
  const root = join(fleet.root, bountyId);
  const socketPath = join(root, "run", "control.sock");
  await Promise.all([
    mkdir(join(root, "run"), { recursive: true }),
    mkdir(join(root, "state"), { recursive: true }),
    mkdir(join(root, "repository"), { recursive: true }),
    mkdir(join(root, "artifacts"), { recursive: true }),
  ]);
  return {
    bountyId,
    vmId: identity.vmId,
    root,
    socketPath,
    daemonEnv: {
      SWORDFISH_BOUNTY_ID: bountyId,
      SWORDFISH_VM_ID: identity.vmId,
      SWORDFISH_REPOSITORY: "withco/bebop",
      SWORDFISH_ASSIGNED_BRANCH: `bounty/${bountyId}`,
      SWORDFISH_BEBOP_WEB_SOCKET_URL: `${bebop.baseUrl.replace(/^http/, "ws")}/swordfish`,
      SWORDFISH_BEBOP_TOKEN: identity.swordfishToken,
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

async function waitForSwordfishExit(daemon: RunningProcess): Promise<void> {
  await waitFor(
    `${daemon.name} exit`,
    async () => (daemon.child.exitCode !== null || daemon.child.signalCode !== null ? true : undefined),
    10_000,
  );
}

async function liveChildren(fleet: LocalFleet): Promise<Array<string>> {
  return fleet.processes
    .filter((processToCheck) => processToCheck.child.exitCode === null && processToCheck.child.signalCode === null)
    .map((processToCheck) => processToCheck.name);
}

suite("local system harness", () => {
  test("packed processes maintain the local protocol floor", async () => {
    const fleet = await makeFleet();
    const database: DisposableDatabase = await createDisposableDatabase("local-system");
    let api: RunningProcess | undefined;
    let worker: RunningProcess | undefined;
    let daemon: RunningProcess | undefined;
    // Asserted after the `finally` block: an assertion inside it would replace a real failure
    // with a teardown failure and hide what actually broke.
    let leaked: Array<string> = [];
    try {
      const apiPort = await availablePort();
      const baseUrl = `http://127.0.0.1:${apiPort}`;
      const bootstrapRoot = join(fleet.root, "bootstrap");
      await mkdir(bootstrapRoot, { recursive: true, mode: 0o700 });
      const bebop: BebopEnv = {
        baseUrl,
        bootstrapRoot,
        env: bebopEnvironment({ apiPort, databaseUrl: database.url, fleetRoot: fleet.root, bootstrapRoot }),
      };

      // worker before API: both migrate and reach health.
      worker = fleet.start("bebop-worker", join(repositoryRoot, "apps/bebop/dist/worker.mjs"), bebop.env);
      await delay(100);
      api = fleet.start("bebop-api", join(repositoryRoot, "apps/bebop/dist/api.mjs"), bebop.env);
      await waitForHealth(baseUrl);
      expect(api.child.exitCode).toBeNull();
      expect(worker.child.exitCode).toBeNull();

      // create retry with one idempotency key yields one bounty, VM mapping, and bootstrap identity.
      const created = await createBounty(fleet, bebop, "local-system-alpha");
      await waitForAttachment(bebop, created.bountyId);
      const provisioned = await readBootstrapArtifact(bootstrapRoot, created.bountyId);
      expect(provisioned.vmId).toBe(`vm-${created.bountyId}`);

      // The retry must not mint a second identity or a second credential: the brief's
      // retry-stability claim is about the artifact, so it is read again rather than assumed.
      const replayed = await createBounty(fleet, bebop, "local-system-alpha");
      expect(replayed.bountyId).toBe(created.bountyId);
      expect(await readBootstrapArtifact(bootstrapRoot, created.bountyId)).toEqual(provisioned);

      // The supervisor consumes the artifact; from here the credential is only in a process
      // environment, and nothing can retrieve it from disk.
      const fixture = await superviseBounty(fleet, bebop, created.bountyId);
      expect(fixture.vmId).toBe(provisioned.vmId);
      expect(await bootstrapArtifactExists(bootstrapRoot, created.bountyId)).toBe(false);

      // Swordfish before listener reaches local interactive, then registers and drains one event.
      daemon = fleet.start(
        "swordfish-alpha",
        join(repositoryRoot, "apps/swordfish/dist/daemon.mjs"),
        fixture.daemonEnv,
      );
      const registered = await waitForSf(
        fleet,
        fixture,
        "alpha registration and acknowledgement",
        (status) =>
          status.stage === "interactive" &&
          status.bebopConnection.state === "connected" &&
          status.bebopConnection.acknowledgedThrough === 1 &&
          status.bebopConnection.pendingEventCount === 0,
      );
      expect(registered.bebopConnection.acknowledgedThrough).toBe(1);
      const projected = await waitFor(
        "Bebop interactive projection",
        async () => {
          const status = await bountyStatus(fleet, bebop, created.bountyId);
          return status.status === "interactive" && status.swordfishFreshness === "connected" ? status : undefined;
        },
        15_000,
      );
      expect(projected.status).toBe("interactive");
      await waitForWorkflowEventCount(baseUrl, created.bountyId, "stage_changed:interactive", 1);

      // API restart restores the acknowledged cursor and produces no duplicate public event.
      await api.stop();
      api = undefined;
      await waitForSf(
        fleet,
        fixture,
        "Swordfish to notice API loss",
        (status) => status.bebopConnection.state === "disconnected",
      );
      api = fleet.start("bebop-api", join(repositoryRoot, "apps/bebop/dist/api.mjs"), bebop.env);
      await waitForHealth(baseUrl);
      await waitForSf(
        fleet,
        fixture,
        "Swordfish to reconnect after API restart",
        (status) =>
          status.bebopConnection.state === "connected" &&
          status.bebopConnection.acknowledgedThrough === 1 &&
          status.bebopConnection.pendingEventCount === 0,
      );
      await waitForWorkflowEventCount(baseUrl, created.bountyId, "stage_changed:interactive", 1);

      // daemon SIGKILL and restart from the same SQLite restores the cursor and projection.
      await daemon.stop("SIGKILL");
      await waitFor(
        "Bebop to observe daemon loss",
        async () => {
          const status = await bountyStatus(fleet, bebop, created.bountyId);
          return status.swordfishFreshness === "disconnected" || status.swordfishFreshness === "stale"
            ? status
            : undefined;
        },
        15_000,
      );
      daemon = fleet.start(
        "swordfish-alpha",
        join(repositoryRoot, "apps/swordfish/dist/daemon.mjs"),
        fixture.daemonEnv,
      );
      await waitForSf(
        fleet,
        fixture,
        "alpha daemon restart",
        (status) =>
          status.stage === "interactive" &&
          status.bebopConnection.state === "connected" &&
          status.bebopConnection.acknowledgedThrough === 1 &&
          status.bebopConnection.pendingEventCount === 0,
      );
      await waitForWorkflowEventCount(baseUrl, created.bountyId, "stage_changed:interactive", 1);

      // local sf cancel projects cancelled while the daemon remains available.
      const cancelled = await fleet.run(
        join(repositoryRoot, "apps/swordfish/dist/cli.mjs"),
        ["cancel", "--socket", fixture.socketPath, "--json"],
        { timeoutMs: 5_000 },
      );
      assert(cancelled.exitCode === 0, `sf cancel failed: ${cancelled.stderr}${cancelled.stdout}`);
      expect((JSON.parse(cancelled.stdout) as SfStatus).stage).toBe("cancelled");
      const delivered = await waitForSf(
        fleet,
        fixture,
        "cancelled event delivery",
        (status) =>
          status.stage === "cancelled" &&
          status.bebopConnection.state === "connected" &&
          status.bebopConnection.acknowledgedThrough === 3 &&
          status.bebopConnection.pendingEventCount === 0,
      );
      expect(delivered.bebopConnection.acknowledgedThrough).toBe(3);
      expect(daemon.child.exitCode).toBeNull();
      const statusAfterCancel = await sfStatus(fleet, fixture.socketPath);
      expect(statusAfterCancel.stage).toBe("cancelled");

      // a Bebop stop queued while Swordfish is offline is delivered once, reports a terminal
      // result, and does not stop the following daemon restart.
      await daemon.stop("SIGKILL");
      await waitForSwordfishExit(daemon);
      const stopped = await stopBounty(fleet, bebop, created.bountyId, "local system harness offline stop");
      expect(stopped.status).toBe("stopped");

      daemon = fleet.start(
        "swordfish-alpha",
        join(repositoryRoot, "apps/swordfish/dist/daemon.mjs"),
        fixture.daemonEnv,
      );
      await waitForSwordfishExit(daemon);
      expect(daemon.child.exitCode).toBe(0);

      daemon = fleet.start(
        "swordfish-alpha",
        join(repositoryRoot, "apps/swordfish/dist/daemon.mjs"),
        fixture.daemonEnv,
      );
      const restarted = await waitForSf(
        fleet,
        fixture,
        "alpha restart after completed stop",
        (status) => status.stage === "cancelled" && status.bebopConnection.state === "connected",
      );
      expect(restarted.stage).toBe("cancelled");
      await delay(1_000);
      expect(daemon.child.exitCode).toBeNull();
      const settled = await waitForSf(
        fleet,
        fixture,
        "alpha cancellation acknowledgements",
        (status) => status.bebopConnection.acknowledgedThrough === 3 && status.bebopConnection.pendingEventCount === 0,
      );
      expect(settled.bebopConnection.acknowledgedThrough).toBe(3);

      // no plaintext credential survives the run.
      expect(await bootstrapArtifactExists(bootstrapRoot, created.bountyId)).toBe(false);
    } finally {
      await fleet.stopAll();
      await database.drop().catch(() => undefined);
      await fleet.clean();
      leaked = await liveChildren(fleet);
    }
    expect(leaked).toEqual([]);
  }, 180_000);

  test("API before worker also migrates and reaches health", async () => {
    const fleet = await makeFleet();
    const database: DisposableDatabase = await createDisposableDatabase("local-system-api-first");
    let api: RunningProcess | undefined;
    let worker: RunningProcess | undefined;
    let leaked: Array<string> = [];
    try {
      const apiPort = await availablePort();
      const baseUrl = `http://127.0.0.1:${apiPort}`;
      const bootstrapRoot = join(fleet.root, "bootstrap");
      await mkdir(bootstrapRoot, { recursive: true, mode: 0o700 });
      const bebop: BebopEnv = {
        baseUrl,
        bootstrapRoot,
        env: bebopEnvironment({ apiPort, databaseUrl: database.url, fleetRoot: fleet.root, bootstrapRoot }),
      };

      api = fleet.start("bebop-api", join(repositoryRoot, "apps/bebop/dist/api.mjs"), bebop.env);
      await waitForHealth(baseUrl);
      worker = fleet.start("bebop-worker", join(repositoryRoot, "apps/bebop/dist/worker.mjs"), bebop.env);
      await delay(500);
      expect(api.child.exitCode).toBeNull();
      expect(worker.child.exitCode).toBeNull();

      const created = await createBounty(fleet, bebop, "local-system-api-first");
      await waitForAttachment(bebop, created.bountyId);
      const identity = await consumeBootstrapArtifact(bootstrapRoot, created.bountyId);
      expect(identity.bountyId).toBe(created.bountyId);
      expect(identity.vmId).toBe(`vm-${created.bountyId}`);
      expect(await bootstrapArtifactExists(bootstrapRoot, created.bountyId)).toBe(false);
    } finally {
      await fleet.stopAll();
      await database.drop().catch(() => undefined);
      await fleet.clean();
      leaked = await liveChildren(fleet);
    }
    expect(leaked).toEqual([]);
  }, 180_000);
});
