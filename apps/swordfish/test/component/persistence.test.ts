import type { CommandMessage } from "@bebop/contracts";
import { CommandMessage as CommandMessageSchema, EventSequence } from "@bebop/contracts";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { SwordfishIdentity } from "#src/domain/identity.ts";
import { SwordfishStore } from "#src/persistence/store.ts";
import { CommandConflictError, WorkflowService } from "#src/workflow/service.ts";
import type { SwordfishHarness } from "#test/component/support/harness.ts";
import { startSwordfishHarness } from "#test/component/support/harness.ts";

let harness: SwordfishHarness | undefined;
const zeroSequence = Schema.decodeUnknownSync(EventSequence)(0);
const firstSequence = Schema.decodeUnknownSync(EventSequence)(1);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function stopCommand(commandId = "cmd-stop"): CommandMessage {
  return Schema.decodeUnknownSync(CommandMessageSchema)({
    type: "command",
    protocolVersion: 1,
    bountyId: "bty-component",
    vmId: "vm-component",
    commandId,
    issuedAt: "2026-07-29T00:00:01.000Z",
    command: { type: "stop", reason: "component test" },
  });
}

describe("Swordfish SQLite authority", () => {
  test("opens in WAL mode, applies migrations, and survives restart with an unacknowledged outbox", async () => {
    harness = await startSwordfishHarness("durability");

    const before = await harness.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* SwordfishStore;
        const journal = yield* sql`PRAGMA journal_mode`;
        const busy = yield* sql`PRAGMA busy_timeout`;
        const foreignKeys = yield* sql`PRAGMA foreign_keys`;
        return {
          journal: journal[0]?.["journal_mode"],
          busy: busy[0]?.["timeout"],
          foreignKeys: foreignKeys[0]?.["foreign_keys"],
          delivery: yield* store.deliveryState,
          pending: yield* store.pendingEvents(zeroSequence),
        };
      }),
    );
    expect(String(before.journal).toLowerCase()).toBe("wal");
    expect(before.busy).toBe(5000);
    expect(before.foreignKeys).toBe(1);
    expect(before.delivery.lastProduced).toBe(1);
    expect(before.delivery.acknowledgedThrough).toBe(0);
    expect(before.pending.map((event) => event.sequence)).toEqual([1]);

    await harness.restart();
    const after = await harness.run(Effect.flatMap(SwordfishStore, (store) => store.pendingEvents(zeroSequence)));
    expect(after.map((event) => event.sequence)).toEqual([1]);

    await harness.run(
      Effect.gen(function* () {
        const store = yield* SwordfishStore;
        const identity = yield* SwordfishIdentity;
        yield* store.acknowledge(firstSequence, yield* identity.now);
      }),
    );
    const acknowledged = await harness.run(
      Effect.flatMap(SwordfishStore, (store) => store.pendingEvents(zeroSequence)),
    );
    expect(acknowledged).toEqual([]);
  });

  test("deduplicates a command and fails closed when its id is reused", async () => {
    harness = await startSwordfishHarness("commands");
    const command = stopCommand();

    const outcomes = await harness.run(
      Effect.gen(function* () {
        const workflow = yield* WorkflowService;
        return [yield* workflow.applyCommand(command), yield* workflow.applyCommand(command)] as const;
      }),
    );
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0].status).toBe("completed");

    const counts = await harness.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const events = yield* sql`SELECT count(*) AS count FROM workflow_events`;
        const commands = yield* sql`SELECT count(*) AS count FROM applied_commands`;
        const workflow = yield* WorkflowService;
        return { events: events[0]?.["count"], commands: commands[0]?.["count"], status: yield* workflow.status };
      }),
    );
    expect(counts.events).toBe(3);
    expect(counts.commands).toBe(1);
    expect(counts.status.stage).toBe("cancelled");

    const conflict = Schema.decodeUnknownSync(CommandMessageSchema)({
      ...Schema.encodeUnknownSync(CommandMessageSchema)(command),
      command: { type: "extend_constraint", constraint: "primary_turns" },
    });
    const exit = await harness.run(
      Effect.exit(Effect.flatMap(WorkflowService, (workflow) => workflow.applyCommand(conflict))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain(CommandConflictError.name);
    }
  });

  test("marks uncertain child and worktree records for operator reconciliation", async () => {
    harness = await startSwordfishHarness("reconciliation");
    await harness.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`
          INSERT INTO reconciliation_records (record_id, kind, path, pid, status, updated_at)
          VALUES ('child-1', 'child_process', '/tmp/worktree', 123, 'running', '2026-07-29T00:00:00.000Z')
        `,
      ),
    );
    await harness.restart();
    const row = await harness.run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT status, detail FROM reconciliation_records`),
    );
    expect(row[0]?.["status"]).toBe("unknown");
    expect(row[0]?.["detail"]).toContain("completion is unknown");
  });

  test("refuses to open authority state under another bounty identity", async () => {
    harness = await startSwordfishHarness("identity");
    await harness.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE daemon_metadata SET bounty_id = 'bty-another' WHERE singleton = 1`,
      ),
    );
    await expect(harness.restart()).rejects.toThrow("database belongs to bty-another");
  });
});
