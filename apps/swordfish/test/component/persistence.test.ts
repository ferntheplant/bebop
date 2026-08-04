import { mkdir } from "node:fs/promises";

import type { CommandMessage } from "@bebop/contracts";
import {
  CommandMessage as CommandMessageSchema,
  EvidenceBundleManifest,
  EventSequence,
  SwordfishEvent,
  Timestamp,
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
const decodeTimestamp = Schema.decodeUnknownSync(Timestamp);
const encodeTimestamp = Schema.encodeSync(Timestamp);

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

function recoveryCommand(command: CommandMessage["command"], commandId: string): CommandMessage {
  return Schema.decodeUnknownSync(CommandMessageSchema)({
    type: "command",
    protocolVersion: 1,
    bountyId: "bty-component",
    vmId: "vm-component",
    commandId,
    issuedAt: "2026-07-29T00:00:01.000Z",
    command: Schema.encodeUnknownSync(CommandMessageSchema.fields.command)(command),
  });
}

/** Drives the building scope to a genuine exhaustion the reducer's own arithmetic will vouch for. */
const exhaustBuildingAttempts = Effect.gen(function* () {
  const workflow = yield* WorkflowService;
  yield* workflow.append(decodeEvent({ type: "cowboy_activated", seat: "ein", seatId: "seat-ein" }));
  yield* workflow.append(
    decodeEvent({
      type: "effective_spec_set",
      spec: {
        revision: 1,
        title: "Exhaust the building allowance",
        goal: "Consume every ein attempt in one build cycle.",
        context: [],
        constraints: [],
        nonGoals: [],
        acceptanceCriteria: [{ id: "ac-1", description: "The allowance runs out." }],
        suggestedQaScenarios: [],
        createdFromSeatId: "seat-ein",
        createdAt: "2026-07-29T00:00:01.000Z",
      },
    }),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    yield* workflow.append(decodeEvent({ type: "attempt_started" }));
    yield* workflow.append(decodeEvent({ type: "attempt_ended", outcome: "no_result" }));
  }
});

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
      command: { type: "resume" },
    });
    const exit = await harness.run(
      Effect.exit(Effect.flatMap(WorkflowService, (workflow) => workflow.applyCommand(conflict))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain(CommandConflictError.name);
    }
  });

  test("a reused seat id keeps its row consistent with the active cowboy", async () => {
    // The reducer refuses a role change for the seat it currently holds, but it keeps no seat history, so an
    // activation reusing a long-deactivated seat ID under another role reaches the table unchallenged. If the
    // row kept the old role it would disagree with `activeCowboy`, and status would fail validation for having
    // no row matching the active cowboy's role and ID together.
    harness = await startSwordfishHarness("seat-role-reuse");
    const status = await harness.run(
      Effect.gen(function* () {
        const workflow = yield* WorkflowService;
        yield* workflow.append(decodeEvent({ type: "cowboy_activated", seat: "ein", seatId: "seat-shared" }));
        yield* workflow.append(decodeEvent({ type: "cowboy_deactivated", seat: "ein", seatId: "seat-shared" }));
        yield* workflow.append(decodeEvent({ type: "cowboy_activated", seat: "jet", seatId: "seat-shared" }));
        return yield* workflow.status;
      }),
    );

    // Decoding the snapshot at all is the assertion: `SfStatusSnapshot` requires the active cowboy to match a
    // listed seat by role and ID together.
    expect(status.activeCowboy).toMatchObject({ role: "jet", seatId: "seat-shared" });
    expect(status.seats).toEqual([{ role: "jet", seatId: "seat-shared" }]);
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
        ledgers: workflow.state.ledgers,
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
    // Taking over does not refund the attempt that started, and it starts none: the ledger is untouched
    // ("Continue preserves an attempt; rerun replaces it" (ADR 0041)).
    expect(afterRetry.ledgers).toEqual(baseline.ledgers);
    expect(afterRetry.commandResults).toHaveLength(1);
    expect(JSON.parse(String(afterRetry.commandResults[0]))).toMatchObject({
      commandId: command.commandId,
      status: "completed",
    });
  });

  test("raises an exhausted budget from the heartbeat wake-up, once, and stops there", async () => {
    // The reducer can only evaluate at event boundaries, and the budget that matters most exists for the case
    // where boundaries stop arriving. This is the wake-up that closes that gap, and it decides nothing itself:
    // the same predicate is re-checked when the event lands ("Constraint exhaustion is computed, not announced"
    // (ADR 0042)).
    harness = await startSwordfishHarness("constraint-wakeup");
    const before = await harness.run(Effect.flatMap(WorkflowService, (workflow) => workflow.evaluateConstraints));
    expect(before).toBe(false);

    await harness.run(exhaustBuildingAttempts);
    const raised = await harness.run(
      Effect.gen(function* () {
        const workflow = yield* WorkflowService;
        const store = yield* SwordfishStore;
        const first = yield* workflow.evaluateConstraints;
        // A second pass changes nothing. The bounty is already saying it needs a human, and a wake-up that
        // restated it every few seconds would bury the reason under its own repetitions.
        const second = yield* workflow.evaluateConstraints;
        return { first, second, status: yield* workflow.status, state: (yield* store.loadWorkflow).state };
      }),
    );
    expect(raised.first).toBe(true);
    expect(raised.second).toBe(false);
    expect(raised.state.stage).toBe("needs_attention");
    expect(raised.state.suspendedStage).toBe("implementing");
    expect(raised.status.attention).toEqual([
      {
        kind: "constraint_exhausted",
        reason: "Autonomous work stopped because building has used all 3 attempts.",
        // There is no attempt to continue, and every command shown can be executed exactly as printed.
        resolutions: ["rerun building", "takeover ein", "stop"],
      },
    ]);
    // Status shows the arithmetic that stopped the bounty, not just the daemon's assertion that something did.
    expect(raised.status.exhausted).toEqual([{ constraint: "attempts", scope: "building", consumed: 3, allowed: 3 }]);
  });

  test("accrues a running attempt through the status observation without persisting it", async () => {
    harness = await startSwordfishHarness("status-attempt-clock");
    const observed = await harness.run(
      Effect.gen(function* () {
        const workflow = yield* WorkflowService;
        const store = yield* SwordfishStore;
        yield* workflow.append(decodeEvent({ type: "cowboy_activated", seat: "ein", seatId: "seat-ein" }));
        yield* workflow.append(
          decodeEvent({
            type: "effective_spec_set",
            spec: {
              revision: 1,
              title: "Observe the running clock",
              goal: "Status reports elapsed autonomous time.",
              context: [],
              constraints: [],
              nonGoals: [],
              acceptanceCriteria: [{ id: "ac-1", description: "Elapsed time is current." }],
              suggestedQaScenarios: [],
              createdFromSeatId: "seat-ein",
              createdAt: "2026-07-29T00:00:01.000Z",
            },
          }),
        );
        yield* workflow.append(decodeEvent({ type: "attempt_started" }));
        const before = (yield* store.loadWorkflow).state;
        const runningSince = before.attempt?.runningSince;
        if (runningSince === null || runningSince === undefined)
          return yield* Effect.die("attempt clock did not start");
        const observedAt = decodeTimestamp(
          new Date(Date.parse(encodeTimestamp(runningSince)) + 89 * 60_000).toISOString(),
        );
        const status = yield* store.status(observedAt);
        const after = (yield* store.loadWorkflow).state;
        return { status, persistedElapsedMs: after.attempt?.elapsedMs };
      }),
    );

    expect(observed.status.attempt?.wallClockMs).toEqual({ consumed: 89 * 60_000, base: 90 * 60_000, granted: 0 });
    expect(observed.status.exhausted).toEqual([]);
    expect(observed.persistedElapsedMs).toBe(0);
  });

  test("rolls back a recovery grant when recording its command result aborts", async () => {
    // A grant is a workflow event now, not a counter update, so what has to commit atomically with the command
    // result is the `attention_cleared` that carries it (ADR 0042). A half-applied recovery would leave the
    // bounty resumed with an attempt nobody was granted, or refuse the retry as a duplicate of a command that
    // granted nothing.
    harness = await startSwordfishHarness("recovery-command-atomicity");
    await harness.run(exhaustBuildingAttempts);
    // The attention comes from the daemon's own wake-up rather than being written by hand, so what this test
    // recovers from is a suspension the production path produced.
    expect(await harness.run(Effect.flatMap(WorkflowService, (workflow) => workflow.evaluateConstraints))).toBe(true);
    const command = recoveryCommand({ type: "rerun", target: "building" }, "cmd-rerun-atomicity");
    const inspect = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* SwordfishStore;
      const commands = yield* sql`SELECT count(*) AS count FROM applied_commands`;
      const events = yield* sql`SELECT count(*) AS count FROM workflow_events`;
      const workflow = yield* store.loadWorkflow;
      return {
        commandCount: commands[0]?.["count"],
        eventCount: events[0]?.["count"],
        ledger: workflow.state.ledgers.building,
        stage: workflow.state.stage,
        attention: workflow.state.attention.map((record) => record.kind),
      };
    });
    const baseline = await harness.run(inspect);
    expect(baseline).toMatchObject({
      stage: "needs_attention",
      attention: ["constraint_exhausted"],
      ledger: { attemptsConsumed: 3, attemptsGranted: 0 },
    });

    const failure = await harness.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const workflow = yield* WorkflowService;
        yield* sql`
          CREATE TEMP TRIGGER abort_test_recovery_command_result
          BEFORE INSERT ON applied_commands
          BEGIN
            SELECT RAISE(ABORT, 'test abort recovery command result');
          END
        `;
        const exit = yield* Effect.exit(workflow.applyCommand(command));
        yield* sql`DROP TRIGGER abort_test_recovery_command_result`;
        return exit;
      }),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(String(failure.cause)).toContain("test abort recovery command result");
    expect(await harness.run(inspect)).toEqual(baseline);

    const result = await harness.run(Effect.flatMap(WorkflowService, (workflow) => workflow.applyCommand(command)));
    expect(result.status).toBe("completed");
    expect(await harness.run(inspect)).toMatchObject({
      commandCount: Number(baseline.commandCount) + 1,
      eventCount: Number(baseline.eventCount) + 1,
      // One more attempt in the building scope, and the reason it answered is gone, so work resumes.
      ledger: { attemptsConsumed: 3, attemptsGranted: 1 },
      stage: "implementing",
      attention: [],
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

  test("restores nontrivial workflow authority, artifacts, the ledger, and command results", async () => {
    harness = await startSwordfishHarness("working-state");
    const command = recoveryCommand({ type: "resume" }, "cmd-resume");
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
        // One real ein attempt, so the restored ledger is something the reducer accrued rather than a zero.
        // The attempt ends before the candidate is submitted: an accepted `candidate-ready` submission ends the
        // ein attempt before local validation runs, which is what structurally excludes deterministic gates
        // from attempt wall clock ("Constraint exhaustion is computed, not announced" (ADR 0042)).
        yield* workflow.append(decodeEvent({ type: "attempt_started" }));
        yield* workflow.append(decodeEvent({ type: "turn_completed" }));
        yield* workflow.append(decodeEvent({ type: "turn_completed" }));
        yield* workflow.append(decodeEvent({ type: "attempt_ended", outcome: "completed" }));
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
        // A safe non-budget suspension, so the `resume` below has something it is permitted to clear.
        yield* workflow.append(
          decodeEvent({
            type: "attention_required",
            kind: "agent_blocked",
            reason: "ein reported it cannot proceed without a decision.",
          }),
        );
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
    // The ledger survives restart because it is part of the workflow snapshot, not a table beside it. `resume`
    // granted nothing, which is exactly what distinguishes it from `continue` and `rerun` (ADR 0041).
    expect(restored.state.ledgers.building).toEqual({ attemptsConsumed: 1, attemptsGranted: 0 });
    expect(restored.state.attempt).toBeNull();
    expect(restored.status.constraints).toContainEqual({
      scope: "building",
      attempts: { consumed: 1, base: 3, granted: 0 },
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
