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
  kindForRerunTarget,
  resolutionsForAttention,
  ProducedEventSequence,
  SwordfishEvent as SwordfishEventSchema,
  Timestamp as TimestampSchema,
} from "@bebop/contracts";
import type { ConstraintExhaustion } from "@bebop/workflow";
import { accrueAttemptClock, exhaustedConstraints, isSuspended, isTerminal } from "@bebop/workflow";
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
  /**
   * Raises `constraint_exhausted` if anything is over budget and nothing has said so yet.
   *
   * The reducer can only evaluate at event boundaries, and the wall-clock budget exists precisely for the case
   * where boundaries stop arriving: a cowboy wedged on a hung tool call emits no `turn_completed`, so the
   * condition fires exactly when the reducer has nothing to fire on. This is that wake-up
   * ("Constraint exhaustion is computed, not announced" (ADR 0042)). It decides nothing itself — it asks the
   * same predicate the reducer will re-check when the event lands.
   *
   * Reports whether it raised, so the caller can log the transition rather than guess at it.
   */
  readonly evaluateConstraints: Effect.Effect<boolean, SqlError.SqlError | WorkflowTransitionError>;
  readonly status: Effect.Effect<SfStatusSnapshot, SqlError.SqlError>;
}

/** The arithmetic, in the words an operator reads in `sf status` beside the commands that clear it. */
function describeExhaustion(exhausted: ReadonlyArray<ConstraintExhaustion>): string {
  const parts = exhausted.map((entry) => {
    const scope = entry.scope === null ? "" : `${entry.scope} `;
    switch (entry.constraint) {
      case "turns":
        return `the ${scope}attempt used ${entry.consumed} of ${entry.allowed} turns`;
      case "wall_clock":
        return `the ${scope}attempt ran for ${Math.round(entry.consumed / 60_000)} of ${Math.round(entry.allowed / 60_000)} minutes`;
      case "attempts":
        return `${scope}has used all ${entry.allowed} attempts`;
      case "validated_candidates":
        return `the spec has used all ${entry.allowed} validated candidates`;
    }
  });
  return `Autonomous work stopped because ${parts.join(", and ")}.`;
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
                kind: "operational",
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
          // Takeover claims control of whichever cowboy is active; it does not select one. There is at most one
          // ("One controller drives one active cowboy" (ADR 0037)), so a seat argument could only ever agree
          // with the state or be wrong.
          //
          // It also clears any outstanding reason that names takeover as an exit, in the same transaction. A
          // takeover that left the record standing would have status keep advertising `takeover` as the way to
          // resolve it while a second attempt was rejected for control already being held, which is precisely
          // what `docs/capabilities/05-control-lease-and-takeover.md` promises will not happen.
          case "takeover": {
            const active = workflow.state.activeCowboy;
            const resolvable = workflow.state.attention.filter((record) =>
              resolutionsForAttention[record.kind].includes("takeover"),
            );
            if (workflow.state.controller === "human") {
              outcome = result(message, "rejected", at, "Human control is already held.");
              break;
            }
            // With no cowboy running there is nothing to interrupt, so this is not a takeover in the sense
            // ADR 0037 refuses — it is a human answering the attention that stopped the bounty, which
            // ADR 0038 permits to establish control on its own.
            if (active === null && resolvable.length === 0) {
              outcome = result(message, "rejected", at, "No cowboy seat is active to take over.");
              break;
            }
            if (active !== null && command.seat !== active.role) {
              outcome = result(message, "rejected", at, `The active cowboy is ${active.role}, not ${command.seat}.`);
              break;
            }
            yield* appendUnsafe(
              { type: "control_changed", controller: "human", reason: active === null ? "attention" : "takeover" },
              at,
            );
            if (resolvable.length > 0) {
              yield* appendUnsafe({ type: "attention_cleared", resolution: "takeover" }, at);
            }
            outcome = result(message, "completed", at);
            break;
          }
          // Handoff releases control from any stage and leaves the stage untouched; Swordfish then starts fresh
          // work for it rather than resuming the aborted turn ("Control passes through a quiescent handoff"
          // (ADR 0036)).
          case "handoff": {
            if (workflow.state.controller !== "human") {
              outcome = result(message, "rejected", at, "Human control is not held.");
              break;
            }
            yield* appendUnsafe({ type: "control_changed", controller: "swordfish", reason: "handoff" }, at);
            outcome = result(message, "completed", at);
            break;
          }
          // The three recovery verbs are the same transition with different grants attached, so they share one
          // admissibility check: is there an outstanding reason this verb is permitted to clear? The reducer
          // decides what the grant then is — reviving an attempt, adding one to a scope, or nothing at all —
          // which is why none of them writes a ledger here ("Continue preserves an attempt; rerun replaces it"
          // (ADR 0041)).
          case "continue":
          case "resume":
          case "rerun": {
            const target = command.type === "rerun" ? command.target : undefined;
            const kind = target === undefined ? null : kindForRerunTarget[target];
            const resolvable = workflow.state.attention.filter(
              (record) =>
                resolutionsForAttention[record.kind].includes(command.type) && (kind === null || record.kind === kind),
            );
            if (resolvable.length === 0) {
              outcome = result(
                message,
                "rejected",
                at,
                kind === null
                  ? `No outstanding attention can be cleared by ${command.type}.`
                  : `No outstanding ${kind} attention can be cleared by rerun ${target}.`,
              );
              break;
            }
            // `continue` revives a suspended attempt, and a budget can run out with none in flight — an
            // allowance exhausted after its final attempt already ended. The reducer refuses that as an illegal
            // transition; catching it here turns it into the operator-facing sentence that names the verb they
            // actually want (ADR 0041).
            if (command.type === "continue" && workflow.state.attempt === null) {
              outcome = result(message, "rejected", at, "There is no suspended attempt to continue; use rerun.");
              break;
            }
            yield* appendUnsafe(
              { type: "attention_cleared", resolution: command.type, ...(target === undefined ? {} : { target }) },
              at,
            );
            outcome = result(message, "completed", at);
            break;
          }
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

    const evaluateConstraints = Effect.gen(function* () {
      const at = yield* identity.now;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const state = (yield* store.loadWorkflow).state;
          // Budgets bound autonomous work only. A human driving, a bounty already stopped, and a bounty already
          // reporting an exhausted budget are all states where raising this again would say nothing new.
          if (state.controller !== "swordfish" || isSuspended(state.stage) || isTerminal(state.stage)) return false;
          if (state.attention.some((record) => record.kind === "constraint_exhausted")) return false;
          // Accrued to now, because the whole point of this wake-up is the time that has passed since the last
          // event. The reducer re-accrues to the same instant when the event lands, so the claim it checks is
          // the claim this made.
          const exhausted = exhaustedConstraints(accrueAttemptClock(state, at));
          if (exhausted.length === 0) return false;
          yield* appendUnsafe(
            { type: "attention_required", kind: "constraint_exhausted", reason: describeExhaustion(exhausted) },
            at,
          );
          yield* Effect.logWarning("constraint exhausted; entering needs_attention").pipe(
            Effect.annotateLogs("bounty_id", config.bountyId),
            Effect.annotateLogs("vm_id", config.vmId),
            Effect.annotateLogs("stage", state.stage),
            Effect.annotateLogs("constraints", exhausted.map((entry) => entry.constraint).join(",")),
          );
          return true;
        }),
      );
    });

    return {
      bootstrap,
      append,
      applyCommand,
      evaluateConstraints,
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
