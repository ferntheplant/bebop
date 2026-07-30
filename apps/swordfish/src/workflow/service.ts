import type {
  BebopCommand,
  CommandId,
  CommandMessage,
  CommandResultMessage,
  EventMessage,
  SfStatusSnapshot,
  SwordfishEvent,
  Timestamp,
} from "@bebop/contracts";
import {
  CommandResultMessage as CommandResultMessageSchema,
  CommandMessage as CommandMessageSchema,
  currentProtocolVersion,
  EventMessage as EventMessageSchema,
  ProducedEventSequence,
  SwordfishEvent as SwordfishEventSchema,
  Timestamp as TimestampSchema,
} from "@bebop/contracts";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql";

import { SwordfishConfiguration } from "#src/config.ts";
import { SwordfishIdentity } from "#src/domain/identity.ts";
import { type AuthorityIdentityError, commandHash, SwordfishStore } from "#src/persistence/store.ts";
import { reduceSwordfishWorkflow, type WorkflowReducerError } from "#src/workflow/reducer.ts";

export class WorkflowTransitionError extends Data.TaggedError("WorkflowTransitionError")<{
  readonly error: WorkflowReducerError;
}> {}

export class CommandConflictError extends Data.TaggedError("CommandConflictError")<{
  readonly commandId: CommandId;
}> {}

export interface WorkflowServiceShape {
  readonly bootstrap: Effect.Effect<void, SqlError.SqlError | AuthorityIdentityError | WorkflowTransitionError>;
  readonly append: (
    event: SwordfishEvent,
    at?: Timestamp,
  ) => Effect.Effect<EventMessage, SqlError.SqlError | WorkflowTransitionError>;
  readonly applyCommand: (
    message: CommandMessage,
  ) => Effect.Effect<CommandResultMessage, SqlError.SqlError | WorkflowTransitionError | CommandConflictError>;
  readonly status: Effect.Effect<SfStatusSnapshot, SqlError.SqlError>;
}

export class WorkflowService extends Context.Service<WorkflowService, WorkflowServiceShape>()("WorkflowService") {}

const decodeEventMessage = Schema.decodeUnknownSync(EventMessageSchema);
const decodeCommandResult = Schema.decodeUnknownSync(CommandResultMessageSchema);
const encodeSwordfishEvent = Schema.encodeUnknownSync(SwordfishEventSchema);
const encodeTimestamp = Schema.encodeSync(TimestampSchema);

export const WorkflowServiceLayer: Layer.Layer<
  WorkflowService,
  never,
  SqlClient.SqlClient | SwordfishConfiguration | SwordfishIdentity | SwordfishStore
> = Layer.effect(WorkflowService)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* SwordfishConfiguration;
    const identity = yield* SwordfishIdentity;
    const store = yield* SwordfishStore;

    const appendUnsafe = (event: SwordfishEvent, at: Timestamp) =>
      Effect.gen(function* () {
        const current = yield* store.loadWorkflow;
        const sequence = Schema.decodeUnknownSync(ProducedEventSequence)(current.state.lastAppliedSequence + 1);
        const message = decodeEventMessage({
          type: "event",
          protocolVersion: currentProtocolVersion,
          bountyId: config.bountyId,
          vmId: config.vmId,
          sequence,
          occurredAt: encodeTimestamp(at),
          event: encodeSwordfishEvent(event),
        });
        const reduced = reduceSwordfishWorkflow(current.state, message);
        if (!reduced.ok) return yield* Effect.fail(new WorkflowTransitionError({ error: reduced.error }));
        if (!reduced.applied) return message;
        yield* store.appendEvent(message, reduced.state);
        return message;
      });

    const append = (event: SwordfishEvent, suppliedAt?: Timestamp) =>
      Effect.gen(function* () {
        const at = suppliedAt ?? (yield* identity.now);
        return yield* sql.withTransaction(appendUnsafe(event, at));
      });

    const bootstrap = Effect.gen(function* () {
      const at = yield* identity.now;
      yield* store.initialize(at);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const reconciliation = yield* store.reconcileLocalState(at);
          const workflow = yield* store.loadWorkflow;
          if (workflow.state.lastAppliedSequence === 0) {
            yield* appendUnsafe({ type: "stage_changed", stage: "interactive" }, at);
          }
          if (reconciliation.uncertainRecords > 0) {
            yield* appendUnsafe(
              {
                type: "attention_required",
                reason: `Startup reconciliation found ${reconciliation.uncertainRecords} local operation(s) with unknown completion.`,
              },
              at,
            );
          }
        }),
      );
    });

    const result = (message: CommandMessage, status: CommandResultMessage["status"], at: Timestamp, error?: string) =>
      decodeCommandResult({
        type: "command_result",
        protocolVersion: currentProtocolVersion,
        bountyId: config.bountyId,
        vmId: config.vmId,
        commandId: message.commandId,
        status,
        reportedAt: encodeTimestamp(at),
        ...(error === undefined ? {} : { error }),
      });

    const applyNewCommand = (message: CommandMessage, at: Timestamp) =>
      Effect.gen(function* () {
        const workflow = yield* store.loadWorkflow;
        const command = message.command;
        let outcome: CommandResultMessage;

        switch (command.type) {
          case "stop":
            if (workflow.state.stage !== "cancelled") {
              if (workflow.state.stage !== "cancelling") {
                yield* appendUnsafe(
                  {
                    type: "stage_changed",
                    stage: "cancelling",
                    ...(command.reason === undefined ? {} : { reason: command.reason }),
                  },
                  at,
                );
              }
              yield* appendUnsafe(
                {
                  type: "stage_changed",
                  stage: "cancelled",
                  ...(command.reason === undefined ? {} : { reason: command.reason }),
                },
                at,
              );
            }
            outcome = result(message, "completed", at);
            break;
          case "takeover": {
            const lease = workflow.state.leases[command.seat];
            if (lease === undefined) {
              outcome = result(message, "rejected", at, `The ${command.seat} seat is not available.`);
              break;
            }
            const anotherHumanSeat = Object.entries(workflow.state.leases).find(
              ([role, current]) => role !== command.seat && current?.owner === "human",
            );
            if (anotherHumanSeat !== undefined) {
              outcome = result(message, "rejected", at, `The ${anotherHumanSeat[0]} seat is already human-controlled.`);
              break;
            }
            if (workflow.state.stage !== "human_controlled") {
              yield* appendUnsafe({ type: "stage_changed", stage: "human_controlled" }, at);
            }
            if (lease.owner !== "human") {
              yield* appendUnsafe(
                { type: "lease_changed", seat: command.seat, seatId: lease.seatId, owner: "human" },
                at,
              );
            }
            outcome = result(message, "completed", at);
            break;
          }
          case "handback": {
            const current = yield* store.loadWorkflow;
            const lease = current.state.leases[command.seat];
            if (lease === undefined || lease.owner !== "human") {
              outcome = result(message, "rejected", at, `Human control does not hold the ${command.seat} seat.`);
              break;
            }
            yield* appendUnsafe(
              { type: "lease_changed", seat: command.seat, seatId: lease.seatId, owner: "swordfish" },
              at,
            );
            const afterLease = yield* store.loadWorkflow;
            const anotherHumanLease = Object.values(afterLease.state.leases).some(
              (current) => current?.owner === "human",
            );
            if (
              !anotherHumanLease &&
              afterLease.state.stage === "human_controlled" &&
              afterLease.state.suspendedStage !== null
            ) {
              yield* appendUnsafe({ type: "stage_changed", stage: afterLease.state.suspendedStage }, at);
            }
            outcome = result(message, "completed", at);
            break;
          }
          case "extend_constraint": {
            const extended = yield* store.extendConstraint(command.constraint, at);
            outcome = extended
              ? result(message, "completed", at)
              : result(message, "rejected", at, `The ${command.constraint} constraint has already been extended.`);
            break;
          }
          case "retry_stage":
            outcome = result(message, "rejected", at, `The ${command.stage} stage has no retryable operation.`);
            break;
          case "approve_config":
            outcome = result(message, "rejected", at, "No configuration approval is pending for this candidate.");
            break;
          case "external_ci_completed": {
            const current = yield* store.loadWorkflow;
            const candidate = current.state.candidate;
            if (
              candidate === null ||
              candidate.commitSha !== command.candidateSha ||
              candidate.specRevision !== command.specRevision ||
              current.state.gates.pr_ci.status !== "pending"
            ) {
              outcome = result(message, "rejected", at, "The external CI result does not match a pending candidate.");
              break;
            }
            yield* appendUnsafe(
              {
                type: "gate_completed",
                gate: "pr_ci",
                candidateSha: command.candidateSha,
                specRevision: command.specRevision,
                outcome: command.outcome,
                ...(command.outcome === "passed"
                  ? {}
                  : {
                      feedback: {
                        kind: "external_ci",
                        checks: [{ name: "Bebop external CI", outcome: "failed" }],
                      },
                    }),
              },
              at,
            );
            outcome = result(message, "completed", at);
            break;
          }
        }

        yield* store.recordCommand({ commandId: message.commandId, command, result: outcome, at });
        return outcome;
      });

    const applyCommand = (message: CommandMessage) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* store.command(message.commandId);
          if (existing !== null) {
            if (existing.commandHash !== commandHash(message.command)) {
              return yield* Effect.fail(new CommandConflictError({ commandId: message.commandId }));
            }
            return existing.result;
          }
          const at = yield* identity.now;
          return yield* applyNewCommand(message, at);
        }),
      );

    return {
      bootstrap,
      append,
      applyCommand,
      status: identity.now.pipe(Effect.flatMap(store.status)),
    };
  }),
);

export function commandMessage(options: {
  readonly commandId: CommandId;
  readonly command: BebopCommand;
  readonly issuedAt: Timestamp;
  readonly config: { readonly bountyId: string; readonly vmId: string };
}): CommandMessage {
  return Schema.decodeUnknownSync(CommandMessageSchema)({
    type: "command",
    protocolVersion: currentProtocolVersion,
    bountyId: options.config.bountyId,
    vmId: options.config.vmId,
    commandId: options.commandId,
    issuedAt: encodeTimestamp(options.issuedAt),
    command: options.command,
  });
}
