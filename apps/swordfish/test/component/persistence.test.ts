import { mkdir } from "node:fs/promises";

import type { CommandMessage } from "@bebop/contracts";
import {
  CommandMessage as CommandMessageSchema,
  EvidenceBundleManifest,
  EventSequence,
  SwordfishEvent,
} from "@bebop/contracts";
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
const candidateSha = "b".repeat(40);
const decodeEvent = Schema.decodeUnknownSync(SwordfishEvent);

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

function extendCommand(commandId = "cmd-extend"): CommandMessage {
  return Schema.decodeUnknownSync(CommandMessageSchema)({
    type: "command",
    protocolVersion: 1,
    bountyId: "bty-component",
    vmId: "vm-component",
    commandId,
    issuedAt: "2026-07-29T00:00:01.000Z",
    command: { type: "extend_constraint", constraint: "primary_turns" },
  });
}

function takeoverCommand(commandId = "cmd-takeover"): CommandMessage {
  return Schema.decodeUnknownSync(CommandMessageSchema)({
    type: "command",
    protocolVersion: 1,
    bountyId: "bty-component",
    vmId: "vm-component",
    commandId,
    issuedAt: "2026-07-29T00:00:01.000Z",
    command: { type: "takeover", seat: "ein", force: false },
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
          pending: yield* store.eventsAfter(zeroSequence),
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
    const after = await harness.run(Effect.flatMap(SwordfishStore, (store) => store.eventsAfter(zeroSequence)));
    expect(after.map((event) => event.sequence)).toEqual([1]);

    await harness.run(
      Effect.gen(function* () {
        const store = yield* SwordfishStore;
        const identity = yield* SwordfishIdentity;
        yield* store.acknowledge(firstSequence, yield* identity.now);
      }),
    );
    const acknowledged = await harness.run(
      Effect.gen(function* () {
        const store = yield* SwordfishStore;
        const identity = yield* SwordfishIdentity;
        return { replayable: yield* store.eventsAfter(zeroSequence), status: yield* store.status(yield* identity.now) };
      }),
    );
    expect(acknowledged.replayable.map((event) => event.sequence)).toEqual([1]);
    expect(acknowledged.status.bebopConnection.pendingEventCount).toBe(0);
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

  test("rolls back a workflow append when the outbox insert aborts, then retries it once", async () => {
    harness = await startSwordfishHarness("append-atomicity");
    const event = decodeEvent({ type: "cowboy_activated", seat: "ein", seatId: "seat-ein" });
    const inspect = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* SwordfishStore;
      const events = yield* sql`
        SELECT count(*) AS count, coalesce(max(sequence), 0) AS max_sequence FROM workflow_events
      `;
      const outbox = yield* sql`
        SELECT count(*) AS count, coalesce(max(sequence), 0) AS max_sequence FROM bebop_outbox
      `;
      const seats = yield* sql`SELECT seat_id FROM seats WHERE role = 'ein'`;
      const stateRows = yield* sql`SELECT state_revision, snapshot FROM workflow_state WHERE singleton = 1`;
      const workflow = yield* store.loadWorkflow;
      return {
        eventCount: events[0]?.["count"],
        eventMaxSequence: events[0]?.["max_sequence"],
        outboxCount: outbox[0]?.["count"],
        outboxMaxSequence: outbox[0]?.["max_sequence"],
        seats: seats.map((row) => ({ seatId: row["seat_id"] })),
        stateRevision: stateRows[0]?.["state_revision"],
        snapshot: stateRows[0]?.["snapshot"],
        lastSequence: workflow.state.lastAppliedSequence,
      };
    });
    const baseline = await harness.run(inspect);

    const failure = await harness.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const workflow = yield* WorkflowService;
        yield* sql`
          CREATE TEMP TRIGGER abort_test_outbox_insert
          BEFORE INSERT ON bebop_outbox
          BEGIN
            SELECT RAISE(ABORT, 'test abort bebop_outbox insert');
          END
        `;
        const exit = yield* Effect.exit(workflow.append(event));
        yield* sql`DROP TRIGGER abort_test_outbox_insert`;
        return exit;
      }),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(String(failure.cause)).toContain("test abort bebop_outbox insert");
    expect(await harness.run(inspect)).toEqual(baseline);

    const retried = await harness.run(Effect.flatMap(WorkflowService, (workflow) => workflow.append(event)));
    const afterRetry = await harness.run(inspect);
    expect(retried.sequence).toBe(Number(baseline.lastSequence) + 1);
    expect(afterRetry).toMatchObject({
      eventCount: Number(baseline.eventCount) + 1,
      eventMaxSequence: Number(baseline.eventMaxSequence) + 1,
      outboxCount: Number(baseline.outboxCount) + 1,
      outboxMaxSequence: Number(baseline.outboxMaxSequence) + 1,
      stateRevision: Number(baseline.stateRevision) + 1,
      lastSequence: Number(baseline.lastSequence) + 1,
      seats: [{ seatId: "seat-ein" }],
    });
    expect(afterRetry.snapshot).not.toBe(baseline.snapshot);
  });

  test("rolls back a mutating command when recording its result aborts, then retries it once", async () => {
    harness = await startSwordfishHarness("command-atomicity");
    await harness.run(
      Effect.flatMap(WorkflowService, (workflow) =>
        workflow.append(decodeEvent({ type: "cowboy_activated", seat: "ein", seatId: "seat-ein" })),
      ),
    );
    const command = takeoverCommand("cmd-takeover-atomicity");
    const inspect = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* SwordfishStore;
      const events = yield* sql`
        SELECT count(*) AS count, coalesce(max(sequence), 0) AS max_sequence FROM workflow_events
      `;
      const outbox = yield* sql`SELECT count(*) AS count FROM bebop_outbox`;
      const stateRows = yield* sql`SELECT state_revision, snapshot FROM workflow_state WHERE singleton = 1`;
      const seats = yield* sql`SELECT seat_id, updated_at FROM seats WHERE role = 'ein'`;
      const constraints = yield* sql`
        SELECT consumed, limit_value, extensions_granted, updated_at
        FROM constraint_ledger WHERE constraint_key = 'primary_turns'
      `;
      const commands = yield* sql`SELECT count(*) AS count FROM applied_commands`;
      const commandResults = yield* sql`
        SELECT result_payload FROM applied_commands WHERE command_id = ${command.commandId}
      `;
      const metadata = yield* sql`SELECT last_applied_command_id FROM daemon_metadata WHERE singleton = 1`;
      const workflow = yield* store.loadWorkflow;
      return {
        eventCount: events[0]?.["count"],
        eventMaxSequence: events[0]?.["max_sequence"],
        outboxCount: outbox[0]?.["count"],
        stateRevision: stateRows[0]?.["state_revision"],
        snapshot: stateRows[0]?.["snapshot"],
        seats: seats.map((row) => ({
          seatId: row["seat_id"],
          updatedAt: row["updated_at"],
        })),
        constraints: constraints.map((row) => ({
          consumed: row["consumed"],
          limit: row["limit_value"],
          extensionsGranted: row["extensions_granted"],
          updatedAt: row["updated_at"],
        })),
        commandCount: commands[0]?.["count"],
        commandResults: commandResults.map((row) => row["result_payload"]),
        lastAppliedCommandId: metadata[0]?.["last_applied_command_id"],
        lastSequence: workflow.state.lastAppliedSequence,
        stage: workflow.state.stage,
        controller: workflow.state.controller,
      };
    });
    const baseline = await harness.run(inspect);

    const failure = await harness.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const workflow = yield* WorkflowService;
        yield* sql`
          CREATE TEMP TRIGGER abort_test_applied_command_insert
          BEFORE INSERT ON applied_commands
          BEGIN
            SELECT RAISE(ABORT, 'test abort applied_commands insert');
          END
        `;
        const exit = yield* Effect.exit(workflow.applyCommand(command));
        yield* sql`DROP TRIGGER abort_test_applied_command_insert`;
        return exit;
      }),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(String(failure.cause)).toContain("test abort applied_commands insert");
    expect(await harness.run(inspect)).toEqual(baseline);

    const result = await harness.run(Effect.flatMap(WorkflowService, (workflow) => workflow.applyCommand(command)));
    const afterRetry = await harness.run(inspect);
    expect(result.status).toBe("completed");
    // Takeover is one event now, not two. It used to write a `stage_changed` to `human_controlled` and then a
    // `lease_changed`; control is a single orthogonal fact, so it is a single `control_changed` (ADR 0037).
    expect(afterRetry).toMatchObject({
      eventCount: Number(baseline.eventCount) + 1,
      eventMaxSequence: Number(baseline.eventMaxSequence) + 1,
      outboxCount: Number(baseline.outboxCount) + 1,
      stateRevision: Number(baseline.stateRevision) + 1,
      commandCount: Number(baseline.commandCount) + 1,
      lastAppliedCommandId: command.commandId,
      lastSequence: Number(baseline.lastSequence) + 1,
      // Takeover leaves the stage where it was and moves control instead (ADR 0037).
      stage: "interactive",
      controller: "human",
    });
    expect(afterRetry.snapshot).not.toBe(baseline.snapshot);
    expect(afterRetry.seats).toEqual([{ seatId: "seat-ein", updatedAt: expect.any(String) }]);
    expect(afterRetry.constraints).toEqual(baseline.constraints);
    expect(afterRetry.commandResults).toHaveLength(1);
    expect(JSON.parse(String(afterRetry.commandResults[0]))).toMatchObject({
      commandId: command.commandId,
      status: "completed",
    });
  });

  test("rolls back a constraint extension when recording its command result aborts", async () => {
    harness = await startSwordfishHarness("constraint-command-atomicity");
    const command = extendCommand("cmd-extend-atomicity");
    const inspect = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const constraints = yield* sql`
        SELECT limit_value, extensions_granted, updated_at
        FROM constraint_ledger WHERE constraint_key = 'primary_turns'
      `;
      const commands = yield* sql`SELECT count(*) AS count FROM applied_commands`;
      const metadata = yield* sql`SELECT last_applied_command_id FROM daemon_metadata WHERE singleton = 1`;
      return {
        constraint: constraints[0],
        commandCount: commands[0]?.["count"],
        lastAppliedCommandId: metadata[0]?.["last_applied_command_id"],
      };
    });
    const baseline = await harness.run(inspect);

    const failure = await harness.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const workflow = yield* WorkflowService;
        yield* sql`
          CREATE TEMP TRIGGER abort_test_constraint_command_result
          BEFORE INSERT ON applied_commands
          BEGIN
            SELECT RAISE(ABORT, 'test abort constraint command result');
          END
        `;
        const exit = yield* Effect.exit(workflow.applyCommand(command));
        yield* sql`DROP TRIGGER abort_test_constraint_command_result`;
        return exit;
      }),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(String(failure.cause)).toContain("test abort constraint command result");
    expect(await harness.run(inspect)).toEqual(baseline);

    const result = await harness.run(Effect.flatMap(WorkflowService, (workflow) => workflow.applyCommand(command)));
    expect(result.status).toBe("completed");
    expect(await harness.run(inspect)).toMatchObject({
      constraint: {
        limit_value: Number(baseline.constraint?.["limit_value"]) + 1,
        extensions_granted: 1,
        updated_at: expect.any(String),
      },
      commandCount: Number(baseline.commandCount) + 1,
      lastAppliedCommandId: command.commandId,
    });
  });

  test("marks surviving and vanished child and worktree records for operator reconciliation", async () => {
    harness = await startSwordfishHarness("reconciliation");
    // A real long-lived child and a real worktree directory: reconciliation must inspect the
    // host, not a fixture answer, to decide that these operations survived the restart.
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await mkdir(`${harness.root}/live-worktree`, { recursive: true });
      await harness.run(
        Effect.gen(function* () {
          const store = yield* SwordfishStore;
          const identity = yield* SwordfishIdentity;
          yield* store.startReconciliation(
            { recordId: "child-live", kind: "child_process", pid: child.pid },
            yield* identity.now,
          );
          yield* store.startReconciliation(
            { recordId: "worktree-live", kind: "worktree", path: `${harness?.root}/live-worktree` },
            yield* identity.now,
          );
          yield* store.startReconciliation(
            { recordId: "worktree-missing", kind: "worktree", path: `${harness?.root}/missing-worktree` },
            yield* identity.now,
          );
        }),
      );
      await harness.restart();
      const reconciled = await harness.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const workflow = yield* WorkflowService;
          return {
            rows: yield* sql`SELECT record_id, status, detail FROM reconciliation_records`,
            status: yield* workflow.status,
          };
        }),
      );
      const byRecordId = new Map(reconciled.rows.map((row) => [row["record_id"], row] as const));
      expect(byRecordId.get("child-live")).toMatchObject({
        status: "needs_attention",
        detail: expect.stringContaining("survived restart"),
      });
      expect(byRecordId.get("worktree-live")).toMatchObject({
        status: "needs_attention",
        detail: expect.stringContaining("survived restart"),
      });
      expect(byRecordId.get("worktree-missing")).toMatchObject({
        status: "unknown",
        detail: expect.stringContaining("completion is unknown"),
      });
      expect(reconciled.status.stage).toBe("needs_attention");
      expect(reconciled.status.recentEvents.at(-1)?.event).toMatchObject({
        type: "attention_required",
        reason: expect.stringContaining("3 local operation"),
      });
    } finally {
      child.kill();
      await child.exited.catch(() => undefined);
    }
  });

  test("restores nontrivial workflow authority, artifacts, constraints, and command results", async () => {
    harness = await startSwordfishHarness("working-state");
    const command = extendCommand();
    const manifest = Schema.decodeUnknownSync(EvidenceBundleManifest)({
      bundleId: "bundle-component",
      bountyId: "bty-component",
      specRevision: 1,
      candidateSha,
      stage: "local_validation",
      provenance: "automated",
      createdAt: "2026-07-29T00:00:05.000Z",
      tools: [{ name: "vitest", version: "4.1.10" }],
      environment: [{ name: "bun", version: "1.3.14" }],
      artifacts: [
        {
          path: "validation/output.log",
          kind: "validator_log",
          sha256: "a".repeat(64),
          sizeBytes: 12,
          mediaType: "text/plain",
        },
      ],
    });

    const firstResult = await harness.run(
      Effect.gen(function* () {
        const workflow = yield* WorkflowService;
        const store = yield* SwordfishStore;
        const identity = yield* SwordfishIdentity;
        yield* workflow.append(decodeEvent({ type: "cowboy_activated", seat: "ein", seatId: "seat-ein" }));
        yield* workflow.append(
          decodeEvent({
            type: "effective_spec_set",
            spec: {
              revision: 1,
              title: "Durable workflow",
              goal: "Restore useful state after restart.",
              context: [],
              constraints: [],
              nonGoals: [],
              acceptanceCriteria: [{ id: "ac-1", description: "State survives restart." }],
              suggestedQaScenarios: [],
              createdFromSeatId: "seat-ein",
              createdAt: "2026-07-29T00:00:01.000Z",
            },
          }),
        );
        yield* workflow.append(
          decodeEvent({
            type: "candidate_submitted",
            candidate: {
              commitSha: candidateSha,
              specRevision: 1,
              summary: "Persist representative authority.",
              claimedLocalChecks: [{ command: "vp test", result: "failed", details: "one failure" }],
              activeDevelopmentServers: [],
              knownLimitations: [],
              disposition: "candidate_ready",
            },
          }),
        );
        yield* workflow.append(
          decodeEvent({
            type: "gate_completed",
            gate: "local_validation",
            candidateSha,
            specRevision: 1,
            outcome: "failed",
            feedback: {
              kind: "validator",
              runs: [
                {
                  command: "vp test",
                  environmentProfile: "clean-room",
                  startedAt: "2026-07-29T00:00:02.000Z",
                  endedAt: "2026-07-29T00:00:03.000Z",
                  outcome: { kind: "exited", code: 1 },
                  capturedOutput: "one failure",
                  artifactPaths: ["validation/output.log"],
                },
              ],
            },
          }),
        );
        expect(yield* store.consumeConstraint("primary_turns", yield* identity.now)).toBe(true);
        yield* store.recordLocalArtifact(manifest);
        yield* store.startReconciliation(
          { recordId: "completed-worktree", kind: "worktree", path: `${harness?.root}/repository` },
          yield* identity.now,
        );
        yield* store.completeReconciliation("completed-worktree", "cleaned", yield* identity.now);
        return yield* workflow.applyCommand(command);
      }),
    );

    await harness.restart();
    const restored = await harness.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const workflow = yield* WorkflowService;
        const store = yield* SwordfishStore;
        const duplicateResult = yield* workflow.applyCommand(command);
        return {
          duplicateResult,
          state: (yield* store.loadWorkflow).state,
          status: yield* workflow.status,
          specs: yield* sql`SELECT count(*) AS count FROM effective_specs`,
          candidates: yield* sql`SELECT count(*) AS count FROM candidates`,
          outcomes: yield* sql`SELECT count(*) AS count FROM validator_outcomes`,
          findings: yield* sql`SELECT count(*) AS count FROM findings`,
          artifacts: yield* sql`SELECT count(*) AS count FROM local_artifacts`,
          commands: yield* sql`SELECT count(*) AS count FROM applied_commands`,
          reconciliation: yield* sql`SELECT status, detail FROM reconciliation_records`,
        };
      }),
    );

    expect(restored.duplicateResult).toEqual(firstResult);
    expect(restored.state).toMatchObject({
      stage: "revision",
      effectiveSpec: { revision: 1 },
      candidate: { commitSha: candidateSha, specRevision: 1 },
      activeCowboy: { role: "ein", seatId: "seat-ein" },
      gates: { local_validation: { status: "failed" } },
    });
    expect(restored.status.constraints.find((entry) => entry.constraint === "primary_turns")).toMatchObject({
      consumed: 1,
      extensionsGranted: 1,
    });
    expect(restored.specs[0]?.["count"]).toBe(1);
    expect(restored.candidates[0]?.["count"]).toBe(1);
    expect(restored.outcomes[0]?.["count"]).toBe(1);
    expect(restored.findings[0]?.["count"]).toBe(1);
    expect(restored.artifacts[0]?.["count"]).toBe(1);
    expect(restored.commands[0]?.["count"]).toBe(1);
    expect(restored.reconciliation[0]).toMatchObject({ status: "completed", detail: "cleaned" });
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
