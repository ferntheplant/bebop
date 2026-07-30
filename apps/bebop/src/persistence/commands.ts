// The durable command queue (SPEC section 18.1, 18.4).
//
// A command survives Swordfish being offline: Bebop writes the row, and the gateway drains
// undelivered rows whenever a connection exists. `command_id` is the deduplication key on
// both sides, so redelivering after an uncertain disconnect is safe — SPEC section 18.3 makes
// deduplication Bebop's job, and Milestone 4 makes it Swordfish's too.

import type { BebopCommand, BountyId, CommandId, CommandResultStatus, Timestamp } from "@bebop/contracts";
import { BebopCommand as BebopCommandSchema, CommandId as CommandIdSchema } from "@bebop/contracts";
import { PgClient } from "@effect/sql-pg";
import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";

import { timestampToIso } from "#src/domain/identity.ts";
import type { Row } from "#src/persistence/rows.ts";
import {
  json,
  jsonbParameter,
  oneOf,
  optionalText,
  optionalTimestamp,
  text,
  timestamp,
} from "#src/persistence/rows.ts";

/**
 * The life of a queued command.
 *
 * `queued` and `delivered` are Bebop's observations; the rest are what Swordfish reported
 * back on `command_result` (SPEC section 18.1). Keeping delivery separate from the reported
 * status is what lets a redelivery after a disconnect be distinguished from a command that
 * was never sent.
 */
export const commandQueueStatuses = ["queued", "delivered", "accepted", "completed", "rejected", "failed"] as const;
export type CommandQueueStatus = (typeof commandQueueStatuses)[number];

export interface QueuedCommand {
  readonly commandId: CommandId;
  readonly bountyId: BountyId;
  readonly command: BebopCommand;
  readonly issuedAt: Timestamp;
  readonly deliveredAt?: Timestamp;
  readonly status: CommandQueueStatus;
  readonly error?: string;
}

const decodeCommandId = Schema.decodeUnknownSync(CommandIdSchema);
const decodeCommand = Schema.decodeUnknownSync(BebopCommandSchema);
const encodeCommand = Schema.encodeUnknownSync(BebopCommandSchema);

function toQueuedCommand(row: Row): QueuedCommand {
  const deliveredAt = optionalTimestamp(row, "delivered_at");
  const error = optionalText(row, "error");
  return {
    commandId: decodeCommandId(text(row, "command_id")),
    bountyId: text(row, "bounty_id") as BountyId,
    command: decodeCommand(json(row, "command")),
    issuedAt: timestamp(row, "issued_at"),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    status: oneOf(row, "status", commandQueueStatuses),
    ...(error === undefined ? {} : { error }),
  };
}

const commandColumns = `command_id, bounty_id, command, issued_at, delivered_at, status, result_reported_at, error`;

export interface CommandRepositoryService {
  /**
   * Queues a command, or returns the existing row for a repeated `commandId`.
   *
   * Enqueuing is idempotent because a retried API request must not turn into a second
   * takeover or a second stop (PLAN Milestone 5: "duplicate commands do not repeat takeover,
   * stop, or retry behavior").
   */
  readonly enqueue: (options: {
    readonly commandId: CommandId;
    readonly bountyId: BountyId;
    readonly command: BebopCommand;
    readonly issuedAt: Timestamp;
  }) => Effect.Effect<QueuedCommand, SqlError.SqlError>;
  readonly pendingDelivery: (options: {
    readonly bountyId: BountyId;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<QueuedCommand>, SqlError.SqlError>;
  readonly markDelivered: (options: {
    readonly commandId: CommandId;
    readonly at: Timestamp;
  }) => Effect.Effect<void, SqlError.SqlError>;
  readonly recordResult: (options: {
    readonly commandId: CommandId;
    readonly bountyId: BountyId;
    readonly status: CommandResultStatus;
    readonly reportedAt: Timestamp;
    readonly error?: string;
  }) => Effect.Effect<CommandQueueStatus | null, SqlError.SqlError>;
  readonly get: (commandId: CommandId) => Effect.Effect<QueuedCommand | null, SqlError.SqlError>;
}

export class CommandRepository extends Context.Service<CommandRepository, CommandRepositoryService>()(
  "CommandRepository",
) {}

export const CommandRepositoryLayer: Layer.Layer<CommandRepository, never, PgClient.PgClient> = Layer.effect(
  CommandRepository,
)(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    return {
      enqueue: ({ bountyId, command, commandId, issuedAt }) =>
        sql`
          INSERT INTO bounty_commands (command_id, bounty_id, command, issued_at, status)
          VALUES (${commandId}, ${bountyId}, ${jsonbParameter(encodeCommand(command))}::jsonb, ${timestampToIso(issuedAt)}, 'queued')
          ON CONFLICT (command_id) DO UPDATE SET command_id = bounty_commands.command_id
          RETURNING ${sql.literal(commandColumns)}
        `.pipe(Effect.map((rows) => toQueuedCommand(rows[0] as Row))),

      pendingDelivery: ({ bountyId, limit }) =>
        sql`
          SELECT ${sql.literal(commandColumns)} FROM bounty_commands
          WHERE bounty_id = ${bountyId} AND status IN ('queued', 'delivered')
          ORDER BY issued_at, command_id
          LIMIT ${limit}
        `.pipe(Effect.map((rows) => rows.map((row) => toQueuedCommand(row as Row)))),

      markDelivered: ({ at, commandId }) =>
        sql`
          UPDATE bounty_commands
          SET delivered_at = coalesce(delivered_at, ${timestampToIso(at)}),
              status = CASE WHEN status = 'queued' THEN 'delivered' ELSE status END
          WHERE command_id = ${commandId}
        `.pipe(Effect.asVoid),

      recordResult: ({ bountyId, commandId, error, reportedAt, status }) =>
        sql`
          UPDATE bounty_commands
          SET status = CASE
                WHEN status IN ('completed', 'rejected', 'failed') THEN status
                ELSE ${status}
              END,
              result_reported_at = CASE
                WHEN status IN ('completed', 'rejected', 'failed') THEN result_reported_at
                ELSE ${timestampToIso(reportedAt)}
              END,
              error = CASE
                WHEN status IN ('completed', 'rejected', 'failed') THEN error
                ELSE ${error ?? null}
              END
          WHERE command_id = ${commandId} AND bounty_id = ${bountyId}
          RETURNING status
        `.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : oneOf(rows[0] as Row, "status", commandQueueStatuses))),
        ),

      get: (commandId) =>
        sql`SELECT ${sql.literal(commandColumns)} FROM bounty_commands WHERE command_id = ${commandId}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : toQueuedCommand(rows[0] as Row))),
        ),
    };
  }),
);
