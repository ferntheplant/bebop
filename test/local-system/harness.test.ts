// The maintained local system harness (`docs/testing.md`).
//
// It runs the packed Bebop API, worker, CLI, Swordfish daemon, and `sf` CLI over loopback
// with disposable Postgres and per-bounty SQLite/socket/artifact roots, and keeps the
// packed-process protocol floor the throwaway probe proved
// (`prototypes/real-process-local-protocol`) maintained. The machine credential travels only
// from Bebop's derivation through `LifecycleProvider.provision` into the environment of the
// daemon the provider starts — never onto disk, and never through an operator retrieval route.
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
  daemonPid,
  delay,
  killDaemon,
  localBountyLayout,
  makeBareOrigin,
  makeFleet,
  processIsAlive,
  repositoryRoot,
  waitFor,
  waitForDaemon,
  type LocalBountyLayout,
  type LocalFleet,
  type RunningProcess,
} from "./support.ts";

const suite = adminDatabaseUrl() === null ? describe.skip : describe;

const credentialKey = "local-system-harness-credential-key-at-least-32-bytes";
const apiToken = "bebop_local-system-harness-bootstrap";

interface BebopEnv {
  readonly baseUrl: string;
  readonly env: Readonly<Record<string, string>>;
  /** The root the provider builds every bounty's machine under. */
  readonly localRoot: string;
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
  readonly localRoot: string;
  readonly gitRoot: string;
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
    // Generous on purpose. Bun closes any connection idle longer than this, including a
    // pooled keep-alive socket this suite is about to reuse, and a starved CI runner crosses
    // a short window easily — which is how a two-second value produced `ECONNRESET` flakes in
    // the component suites before they moved to a generous one (`docs/gotchas.md`). Nothing
    // here tests the idle window, so nothing here should be near it.
    BEBOP_HTTP_IDLE_TIMEOUT: "30 seconds",
    BEBOP_SWORDFISH_CREDENTIAL_KEY: credentialKey,
    BEBOP_BOOTSTRAP_API_TOKEN: apiToken,
    // Local machine mode: a provisioned bounty is a real detached daemon under this root,
    // started from the same packed artifact an operator runs.
    BEBOP_LOCAL_HARNESS_ROOT: options.localRoot,
    BEBOP_LOCAL_SWORDFISH_ENTRYPOINT: join(repositoryRoot, "apps/swordfish/dist/daemon.mjs"),
    // A bare repository on disk rather than GitHub: the clone is real, and the suite stays
    // offline and repeatable. An operator's default is `https://github.com/`.
    BEBOP_LOCAL_GIT_REMOTE_BASE: `file://${options.gitRoot}/`,
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
  // The endpoint streams the backlog and then stays open for live events, so it never ends on
  // its own and the client has to decide when it has everything. Ending on a quiet period
  // rather than a fixed deadline is what makes a read *complete* rather than merely long: the
  // backlog arrives as a burst, so a gap in it is the only available signal that it drained.
  // A fixed deadline cannot distinguish "drained" from "cut off mid-backlog", which is exactly
  // how a truncated read can impersonate a stable one.
  //
  // The hard cap is a backstop for a stream that never goes quiet, and stays well under
  // `BEBOP_HTTP_IDLE_TIMEOUT` so the server never closes the connection first.
  const quietMs = 400;
  const hardCap = setTimeout(() => controller.abort(), 5_000);
  // One decoder for the whole stream: a per-chunk decoder cannot carry the `stream: true`
  // state that reassembles a multi-byte character split across two chunks.
  const decoder = new TextDecoder();
  let text = "";
  try {
    const response = await fetch(`${baseUrl}/api/bounties/${bountyId}/events`, {
      headers: { authorization: `Bearer ${apiToken}` },
      signal: controller.signal,
    });
    assert(response.ok && response.body !== null, `event replay returned ${response.status}`);
    const reader = response.body.getReader();
    for (;;) {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<"quiet">((resolveQuiet) => {
        quietTimer = setTimeout(() => resolveQuiet("quiet"), quietMs);
      });
      const next = await Promise.race([reader.read(), quiet]);
      clearTimeout(quietTimer);
      if (next === "quiet" || next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    controller.abort();
  } catch (error) {
    if (text.length === 0 && !(error instanceof DOMException && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(hardCap);
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
  // Retry until the read is *complete enough to be evidence* — at least `expected` — and only
  // then assert equality. Two failure modes have to be told apart here, and accepting the
  // first successful read cannot do it: a short read and a stable count look identical, so a
  // truncated replay would satisfy a `<=` assertion and hide a duplicate that came after the
  // frames it managed to see. A read that never reaches `expected` times out loudly instead.
  const settled = await waitFor(`a settled read of ${key}`, async () => {
    const counts = workflowEventCounts(await replayPublicEvents(baseUrl, bountyId));
    return (counts[key] ?? 0) >= expected ? counts : undefined;
  });
  assert(
    (settled[key] ?? 0) === expected,
    `${key} settled at ${settled[key] ?? 0} public events, expected exactly ${expected}`,
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

/**
 * Requeues the bounty's provisioning job over the API.
 *
 * This is how a daemon gets restarted here: the harness cannot start one itself — the machine
 * credential is never written down — and provisioning is what makes a machine exist. Driving it
 * through the endpoint is also the closer analogue of what actually happens in production, where
 * a re-provision is the only thing that revives a VM.
 */
async function recoverBounty(bebop: BebopEnv, bountyId: string): Promise<void> {
  const response = await fetch(`${bebop.baseUrl}/api/bounties/${bountyId}/recover`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assert(response.ok, `bebop recover failed: ${response.status} ${await response.text()}`);
}

async function destroyBounty(bebop: BebopEnv, bountyId: string): Promise<void> {
  const response = await fetch(`${bebop.baseUrl}/api/bounties/${bountyId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assert(response.ok, `bebop destroy failed: ${response.status} ${await response.text()}`);
}

/**
 * Retrieves the operator credential through the packed `bebop` CLI.
 *
 * This is the retrieval route's end-to-end coverage through a real entrypoint: the CLI
 * derives the credential on the server and prints the plaintext, and the harness feeds it to
 * `sf cancel` over stdin exactly as a human would (`docs/capabilities/05-control-lease-and-takeover.md`).
 */
async function operatorCredential(fleet: LocalFleet, bebop: BebopEnv, bountyId: string): Promise<string> {
  const outcome = await fleet.run(
    join(repositoryRoot, "apps/bebop/dist/cli.mjs"),
    ["bounty", "operator-credential", "--bounty", bountyId, "--url", bebop.baseUrl, "--token", apiToken, "--json"],
    { timeoutMs: 15_000 },
  );
  assert(outcome.exitCode === 0, `bebop operator-credential failed: ${outcome.stderr}${outcome.stdout}`);
  return (JSON.parse(outcome.stdout) as { operatorCredential: string }).operatorCredential;
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
  layout: LocalBountyLayout,
  description: string,
  predicate: (status: SfStatus) => boolean,
): Promise<SfStatus> {
  return await waitFor(description, async () => {
    const status = await sfStatus(fleet, layout.socketPath);
    return predicate(status) ? status : undefined;
  });
}

/**
 * Waits for the provider to record a machine other than `previousPid`, and returns its pid.
 *
 * Recorded rather than alive, because a daemon started to drain a terminal command exits almost
 * at once: waiting on liveness would race that exit and never see it. The provider writes the
 * record immediately after the spawn, so the record is the observation that cannot be missed.
 */
async function waitForNewDaemon(layout: LocalBountyLayout, previousPid: number, description: string): Promise<number> {
  return await waitFor(
    description,
    async () => {
      const current = await daemonPid(layout);
      return current !== undefined && current !== previousPid ? current : undefined;
    },
    30_000,
  );
}

async function waitForDaemonExit(pid: number, description: string): Promise<void> {
  await waitFor(description, async () => (processIsAlive(pid) ? undefined : true), 30_000);
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
    // The daemon is not a fleet process: it is detached on purpose and outlives the worker, so
    // teardown reaches it through the layout rather than through the fleet.
    let layout: LocalBountyLayout | undefined;
    // Asserted after the `finally` block: an assertion inside it would replace a real failure
    // with a teardown failure and hide what actually broke.
    let leaked: Array<string> = [];
    try {
      const apiPort = await availablePort();
      const baseUrl = `http://127.0.0.1:${apiPort}`;
      const localRoot = join(fleet.root, "local");
      const gitRoot = join(fleet.root, "git");
      await mkdir(localRoot, { recursive: true, mode: 0o700 });
      await makeBareOrigin(gitRoot, "withco/bebop");
      const bebop: BebopEnv = {
        baseUrl,
        localRoot,
        env: bebopEnvironment({ apiPort, databaseUrl: database.url, fleetRoot: fleet.root, localRoot, gitRoot }),
      };

      // worker before API: both migrate and reach health.
      worker = fleet.start("bebop-worker", join(repositoryRoot, "apps/bebop/dist/worker.mjs"), bebop.env);
      await delay(100);
      api = fleet.start("bebop-api", join(repositoryRoot, "apps/bebop/dist/api.mjs"), bebop.env);
      await waitForHealth(baseUrl);
      expect(api.child.exitCode, api.output()).toBeNull();
      expect(worker.child.exitCode, worker.output()).toBeNull();

      // create retry with one idempotency key yields one bounty, VM mapping, and bootstrap identity.
      const created = await createBounty(fleet, bebop, "local-system-alpha");
      await waitForAttachment(bebop, created.bountyId);
      layout = localBountyLayout(localRoot, created.bountyId);

      // The shipped path, with no manual step in between: creating a bounty is what makes a
      // Swordfish daemon exist, because locally the lifecycle provider starts it
      // ([A local Swordfish outlives the worker that started it (ADR
      // 0048)](../../docs/adr/0048-a-local-swordfish-outlives-the-worker-that-started-it.md)).
      const pid = await waitForDaemon(layout, "the provider to start a Swordfish daemon");
      expect(processIsAlive(pid)).toBe(true);

      // A repeated create under one idempotency key must not mint a second identity, and must
      // not leave a second daemon behind.
      //
      // This covers the create path only: an idempotency-keyed create short-circuits at the
      // API and never reaches the lifecycle job twice. Stability across an actual re-provision
      // — the retry that made derivation preferable to a random token in
      // [Swordfish tokens are bounty-scoped, minted at provisioning, and never rotate (ADR
      // 0014)](../../docs/adr/0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md) —
      // is covered at the component layer, which can inject the failure that triggers it:
      // `apps/bebop/test/component/lifecycle.test.ts`, "retries an uncertain provision with
      // the same credential".
      const replayed = await createBounty(fleet, bebop, "local-system-alpha");
      expect(replayed.bountyId).toBe(created.bountyId);
      expect(await daemonPid(layout)).toBe(pid);

      const registered = await waitForSf(
        fleet,
        layout,
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
        layout,
        "Swordfish to notice API loss",
        (status) => status.bebopConnection.state === "disconnected",
      );
      api = fleet.start("bebop-api", join(repositoryRoot, "apps/bebop/dist/api.mjs"), bebop.env);
      await waitForHealth(baseUrl);
      await waitForSf(
        fleet,
        layout,
        "Swordfish to reconnect after API restart",
        (status) =>
          status.bebopConnection.state === "connected" &&
          status.bebopConnection.acknowledgedThrough === 1 &&
          status.bebopConnection.pendingEventCount === 0,
      );
      await waitForWorkflowEventCount(baseUrl, created.bountyId, "stage_changed:interactive", 1);

      // A daemon killed outright is replaced through the shipped path, not by the harness.
      // `recover` requeues the provision job, provisioning is what starts a machine, and the
      // fresh daemon opens the same SQLite — so the acknowledged cursor survives a process it
      // never got to shut down cleanly.
      await killDaemon(layout);
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
      await recoverBounty(bebop, created.bountyId);
      const machine = layout;
      const replacedPid = await waitForNewDaemon(machine, pid, "the provider to replace the killed daemon");
      expect(processIsAlive(replacedPid)).toBe(true);
      const restarted = await waitForSf(
        fleet,
        layout,
        "alpha daemon restart",
        (status) =>
          status.stage === "interactive" &&
          status.bebopConnection.state === "connected" &&
          status.bebopConnection.acknowledgedThrough === 1 &&
          status.bebopConnection.pendingEventCount === 0,
      );
      expect(restarted.bebopConnection.acknowledgedThrough).toBe(1);
      await waitForWorkflowEventCount(baseUrl, created.bountyId, "stage_changed:interactive", 1);

      // A provision that finds a live daemon leaves it strictly alone. This is the property a
      // worker crash depends on: retrying provisioning must not end with two daemons, or with
      // the bounty's loop cut short by bebop restarting
      // ([A local Swordfish outlives the worker that started it (ADR
      // 0048)](../../docs/adr/0048-a-local-swordfish-outlives-the-worker-that-started-it.md)).
      await recoverBounty(bebop, created.bountyId);
      await delay(2_000);
      expect(await daemonPid(layout)).toBe(replacedPid);
      expect(processIsAlive(replacedPid)).toBe(true);

      // local sf cancel projects cancelled while the daemon remains available. The credential
      // travels from Bebop's derivation through the retrieval CLI and into the daemon over the
      // socket; the harness never derives it test-side.
      const credential = await operatorCredential(fleet, bebop, created.bountyId);

      // Enforcement, as the operator meets it: a wrong credential against the daemon the
      // provider started, refused as a sentence on stderr rather than a stack trace. The
      // successful cancel below is what proves the refusal changed nothing — a mutation that
      // had applied would leave the second cancel refusing an invalid state.
      const refused = await fleet.run(
        join(repositoryRoot, "apps/swordfish/dist/cli.mjs"),
        ["cancel", "--socket", layout.socketPath, "--json"],
        { timeoutMs: 5_000, stdin: "bebop_op_not-the-real-credential\n" },
      );
      assert(refused.exitCode !== 0, "sf cancel accepted a wrong operator credential");
      expect(refused.stderr).toContain("valid operator credential");
      expect(refused.stdout).toBe("");

      const cancelled = await fleet.run(
        join(repositoryRoot, "apps/swordfish/dist/cli.mjs"),
        ["cancel", "--socket", layout.socketPath, "--json"],
        { timeoutMs: 5_000, stdin: `${credential}\n` },
      );
      assert(cancelled.exitCode === 0, `sf cancel failed: ${cancelled.stderr}${cancelled.stdout}`);
      expect((JSON.parse(cancelled.stdout) as SfStatus).stage).toBe("cancelled");
      const delivered = await waitForSf(
        fleet,
        layout,
        "cancelled event delivery",
        (status) =>
          status.stage === "cancelled" &&
          status.bebopConnection.state === "connected" &&
          status.bebopConnection.acknowledgedThrough === 3 &&
          status.bebopConnection.pendingEventCount === 0,
      );
      expect(delivered.bebopConnection.acknowledgedThrough).toBe(3);
      expect(processIsAlive(replacedPid)).toBe(true);

      // A Bebop stop queued while Swordfish is offline is delivered once, reports a terminal
      // result, and does not stop the following daemon restart. `bebop bounty stop` has no
      // other automated coverage, and the durable command queue is what makes it work at all:
      // the daemon that eventually reads it was not running when it was issued.
      await killDaemon(machine);
      const stopped = await stopBounty(fleet, bebop, created.bountyId, "local system harness offline stop");
      expect(stopped.status).toBe("stopped");

      // Provisioning is the only thing that makes a machine, so it is also how the queued stop
      // reaches one. The daemon drains it, reports its terminal result, and exits.
      await recoverBounty(bebop, created.bountyId);
      const stopDrainPid = await waitForNewDaemon(machine, replacedPid, "a daemon to drain the queued stop");
      await waitForDaemonExit(stopDrainPid, "the stop-draining daemon to exit");

      // And a completed stop leaves the bounty restartable rather than wedged: the next daemon
      // comes up on the same SQLite, reports the stage the cancel left, and is not handed the
      // stop a second time.
      await recoverBounty(bebop, created.bountyId);
      const afterStopPid = await waitForNewDaemon(machine, stopDrainPid, "a daemon after the completed stop");
      const afterStop = await waitForSf(
        fleet,
        layout,
        "alpha restart after completed stop",
        (status) => status.stage === "cancelled" && status.bebopConnection.state === "connected",
      );
      expect(afterStop.stage).toBe("cancelled");
      // Still up a moment later: a redelivered stop would have taken it down again.
      await delay(1_000);
      expect(processIsAlive(afterStopPid)).toBe(true);

      // Destroying is what ends a local machine. Nothing else does: the daemon is detached, so
      // an undestroyed bounty keeps running after every bebop process has exited.
      await destroyBounty(bebop, created.bountyId);
      // The record clearing is what says the stop completed, not the process dying: the daemon
      // exits first and the provider removes the record afterwards, so asserting on liveness
      // alone would race that window.
      await waitFor(
        "the provider to stop the daemon and clear its record",
        async () => ((await daemonPid(machine)) === undefined && !processIsAlive(afterStopPid) ? true : undefined),
        30_000,
      );
    } finally {
      // The daemon is detached, so nothing in the fleet's shutdown reaches it. A test that
      // failed before `destroy` would otherwise leave one running on the developer's machine.
      if (layout !== undefined) await killDaemon(layout).catch(() => undefined);
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
    let layout: LocalBountyLayout | undefined;
    let leaked: Array<string> = [];
    try {
      const apiPort = await availablePort();
      const baseUrl = `http://127.0.0.1:${apiPort}`;
      const localRoot = join(fleet.root, "local");
      const gitRoot = join(fleet.root, "git");
      await mkdir(localRoot, { recursive: true, mode: 0o700 });
      await makeBareOrigin(gitRoot, "withco/bebop");
      const bebop: BebopEnv = {
        baseUrl,
        localRoot,
        env: bebopEnvironment({ apiPort, databaseUrl: database.url, fleetRoot: fleet.root, localRoot, gitRoot }),
      };

      api = fleet.start("bebop-api", join(repositoryRoot, "apps/bebop/dist/api.mjs"), bebop.env);
      await waitForHealth(baseUrl);
      worker = fleet.start("bebop-worker", join(repositoryRoot, "apps/bebop/dist/worker.mjs"), bebop.env);
      await delay(500);
      expect(api.child.exitCode, api.output()).toBeNull();
      expect(worker.child.exitCode, worker.output()).toBeNull();

      const created = await createBounty(fleet, bebop, "local-system-api-first");
      await waitForAttachment(bebop, created.bountyId);
      layout = localBountyLayout(localRoot, created.bountyId);
      const pid = await waitForDaemon(layout, "the provider to start a Swordfish daemon");
      expect(processIsAlive(pid)).toBe(true);
    } finally {
      if (layout !== undefined) await killDaemon(layout).catch(() => undefined);
      await fleet.stopAll();
      await database.drop().catch(() => undefined);
      await fleet.clean();
      leaked = await liveChildren(fleet);
    }
    expect(leaked).toEqual([]);
  }, 180_000);
});
