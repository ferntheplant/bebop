// The `bebop` CLI against a real API (`docs/capabilities/01-bounty-lifecycle.md`).
//
// The CLI is run as a process, not imported, because half of what it has to get right is
// process behaviour: argv parsing, exit status, and what lands on stdout. `prototypes/effect-runtime`
// finding 4 is the reason that is worth asserting — a missing `Stdio` layer breaks every
// invocation including `--help`, and nothing but running it would notice.

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Harness } from "#test/component/support/harness.ts";
import { startHarness, testDatabaseAvailable } from "#test/component/support/harness.ts";

const suite = testDatabaseAvailable ? describe : describe.skip;

const cliEntrypoint = new URL("../../src/cli.ts", import.meta.url).pathname;

async function runCli(
  harness: Harness,
  args: ReadonlyArray<string>,
  options?: { readonly withoutToken?: boolean },
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  const child = Bun.spawn(["bun", cliEntrypoint, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BEBOP_API_URL: harness.baseUrl,
      ...(options?.withoutToken === true ? { BEBOP_TOKEN: "" } : { BEBOP_TOKEN: harness.token }),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

suite("bebop CLI", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness("cli");
  });

  afterAll(async () => {
    await harness.close();
  });

  test("reports health", async () => {
    const outcome = await runCli(harness, ["health"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("ok");
  });

  test("prints the API's own response under --json", async () => {
    const outcome = await runCli(harness, ["health", "--json"]);
    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(outcome.stdout) as { status: string; checkedAt: string };
    expect(parsed.status).toBe("ok");
    // Re-encoded through the response schema, so a script sees the wire form rather than a
    // decoded `DateTime`.
    expect(parsed.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("creates, lists, and reports a bounty", async () => {
    const created = await runCli(harness, [
      "bounty",
      "create",
      "--repository",
      "withco/bebop",
      "--base-ref",
      "main",
      "--context",
      "context7",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    const bounty = JSON.parse(created.stdout) as { bountyId: string; status: string };
    expect(bounty.status).toBe("provisioning");

    const listed = await runCli(harness, ["bounty", "list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(bounty.bountyId);

    const status = await runCli(harness, ["bounty", "status", "--bounty", bounty.bountyId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`bounty/${bounty.bountyId}`);
  });

  test("repeating a create with one idempotency key yields one bounty", async () => {
    const args = [
      "bounty",
      "create",
      "--repository",
      "withco/bebop",
      "--base-ref",
      "main",
      "--idempotency-key",
      "cli-fixed-key",
      "--json",
    ];
    const first = JSON.parse((await runCli(harness, args)).stdout) as { bountyId: string };
    const second = JSON.parse((await runCli(harness, args)).stdout) as { bountyId: string };
    expect(second.bountyId).toBe(first.bountyId);
  });

  test("reconnects the event tail after the server idle timeout", async () => {
    const created = await runCli(harness, [
      "bounty",
      "create",
      "--repository",
      "withco/bebop",
      "--base-ref",
      "main",
      "--json",
    ]);
    const bountyId = (JSON.parse(created.stdout) as { bountyId: string }).bountyId;

    const child = Bun.spawn(["bun", cliEntrypoint, "bounty", "events", "--bounty", bountyId], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BEBOP_API_URL: harness.baseUrl, BEBOP_TOKEN: harness.token },
    });
    // The harness server drops an idle stream after two seconds. Produce the next event only
    // after that deadline so this is observable solely if the CLI reconnects from its cursor.
    await new Promise((resolve) => setTimeout(resolve, 2_700));
    await harness.request(`/api/bounties/${bountyId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "idle reconnect test" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.kill();
    const stdout = await new Response(child.stdout).text();
    await child.exited;
    expect(stdout).toContain("status provisioning");
    expect(stdout).toContain("status stopped");
  }, 10_000);

  test("fails with a nonzero status when the credential is missing", async () => {
    const outcome = await runCli(harness, ["bounty", "list"], { withoutToken: true });
    expect(outcome.exitCode).not.toBe(0);
  });

  test("fails with a nonzero status when the bounty does not exist", async () => {
    const outcome = await runCli(harness, ["bounty", "status", "--bounty", "bty-missing"]);
    expect(outcome.exitCode).not.toBe(0);
  });

  test("refuses to run without an API URL", async () => {
    const child = Bun.spawn(["bun", cliEntrypoint, "health"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BEBOP_API_URL: "", BEBOP_TOKEN: "" },
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("BEBOP_API_URL");
  });
});
