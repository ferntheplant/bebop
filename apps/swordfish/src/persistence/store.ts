import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

import type {
  BebopCommand,
  CommandId,
  CommandResultMessage,
  ConstraintKey,
  EvidenceBundleManifest,
  EventMessage,
  EventSequence,
  SfStatusSnapshot,
  Timestamp,
} from "@bebop/contracts";
import {
  CommandResultMessage as CommandResultMessageSchema,
  constraintKeys,
  defaultConstraintProfile,
  EvidenceBundleManifest as EvidenceBundleManifestSchema,
  EventMessage as EventMessageSchema,
  PrivatePreviewAttachments,
  resolutionsForAttention,
  SfStatusSnapshot as SfStatusSnapshotSchema,
  SwordfishEvent as SwordfishEventSchema,
} from "@bebop/contracts";
import { eventFingerprint } from "@bebop/workflow";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql";

import { SwordfishConfiguration } from "#src/config.ts";
import { timestampToIso } from "#src/domain/identity.ts";
import {
  decodeWorkflowSnapshot,
  encodeWorkflowSnapshot,
  fromWorkflowSnapshot,
  toWorkflowSnapshot,
} from "#src/persistence/workflow-snapshot.ts";
import { makeInitialSwordfishWorkflowState, type SwordfishWorkflowState } from "#src/workflow/reducer.ts";

type Row = Readonly<Record<string, unknown>>;

export class AcknowledgementError extends Data.TaggedError("AcknowledgementError")<{
  readonly acknowledgedThrough: number;
  readonly lastProduced: number;
}> {}

export class AuthorityIdentityError extends Data.TaggedError("AuthorityIdentityError")<{
  readonly field: "bountyId" | "vmId" | "repository" | "assignedBranch";
  readonly configured: string;
  readonly stored: string;
}> {
  override get message(): string {
    return `Swordfish ${this.field} is ${this.configured}, but this database belongs to ${this.stored}.`;
  }
}

export interface StoredWorkflow {
  readonly stateRevision: number;
  readonly state: SwordfishWorkflowState;
}

export interface StoredCommand {
  readonly commandHash: string;
  readonly result: CommandResultMessage;
}

export interface DeliveryState {
  readonly lastProduced: EventSequence;
  readonly acknowledgedThrough: EventSequence;
  readonly lastAppliedCommandId?: CommandId;
}

export type ReconciliationResource =
  | {
      readonly recordId: string;
      readonly kind: "child_process";
      readonly pid: number;
      readonly path?: string;
    }
  | {
      readonly recordId: string;
      readonly kind: "worktree";
      readonly path: string;
    };

export interface ReconciliationSummary {
  readonly uncertainRecords: number;
}

export interface SwordfishStoreService {
  readonly initialize: (at: Timestamp) => Effect.Effect<void, SqlError.SqlError | AuthorityIdentityError>;
  readonly loadWorkflow: Effect.Effect<StoredWorkflow, SqlError.SqlError>;
  readonly appendEvent: (
    message: EventMessage,
    state: SwordfishWorkflowState,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly eventsAfter: (
    after: EventSequence,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<EventMessage>, SqlError.SqlError>;
  readonly deliveryState: Effect.Effect<DeliveryState, SqlError.SqlError>;
  readonly acknowledge: (
    through: EventSequence,
    at: Timestamp,
  ) => Effect.Effect<void, SqlError.SqlError | AcknowledgementError>;
  readonly setConnected: (connected: boolean, at: Timestamp) => Effect.Effect<void, SqlError.SqlError>;
  readonly status: (observedAt: Timestamp) => Effect.Effect<SfStatusSnapshot, SqlError.SqlError>;
  readonly command: (commandId: CommandId) => Effect.Effect<StoredCommand | null, SqlError.SqlError>;
  readonly recordCommand: (options: {
    readonly commandId: CommandId;
    readonly command: BebopCommand;
    readonly result: CommandResultMessage;
    readonly at: Timestamp;
  }) => Effect.Effect<void, SqlError.SqlError>;
  readonly recordLocalArtifact: (manifest: EvidenceBundleManifest) => Effect.Effect<void, SqlError.SqlError>;
  readonly startReconciliation: (
    resource: ReconciliationResource,
    at: Timestamp,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly completeReconciliation: (
    recordId: string,
    detail: string | undefined,
    at: Timestamp,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly consumeConstraint: (constraint: ConstraintKey, at: Timestamp) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly extendConstraint: (constraint: ConstraintKey, at: Timestamp) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly reconcileLocalState: (at: Timestamp) => Effect.Effect<ReconciliationSummary, SqlError.SqlError>;
}

export class SwordfishStore extends Context.Service<SwordfishStore, SwordfishStoreService>()("SwordfishStore") {}

const decodeEvent = Schema.decodeUnknownSync(EventMessageSchema);
const encodeEvent = Schema.encodeUnknownSync(EventMessageSchema);
const decodeCommandResult = Schema.decodeUnknownSync(CommandResultMessageSchema);
const encodeCommandResult = Schema.encodeUnknownSync(CommandResultMessageSchema);
const encodeEvidenceManifest = Schema.encodeUnknownSync(EvidenceBundleManifestSchema);
const encodePreviews = Schema.encodeUnknownSync(PrivatePreviewAttachments);
const encodeSwordfishEvent = Schema.encodeUnknownSync(SwordfishEventSchema);
const decodeStatus = Schema.decodeUnknownSync(SfStatusSnapshotSchema);

function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number") throw new TypeError(`Expected numeric ${key}`);
  return value;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`Expected text ${key}`);
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`Expected optional text ${key}`);
  return value;
}

function commandHash(command: BebopCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

function constraintDefaults(): Readonly<Record<ConstraintKey, number>> {
  return {
    primary_turns: defaultConstraintProfile.primary.maxTurnsPerAttempt,
    primary_wall_clock: defaultConstraintProfile.primary.maxWallClockMinutesPerAttempt,
    review_rounds: defaultConstraintProfile.review.maxRounds,
    review_turns: defaultConstraintProfile.review.maxTurnsPerAttempt,
    review_wall_clock: defaultConstraintProfile.review.maxWallClockMinutesPerAttempt,
    qa_rounds: defaultConstraintProfile.qa.maxRounds,
    qa_turns: defaultConstraintProfile.qa.maxTurnsPerAttempt,
    qa_wall_clock: defaultConstraintProfile.qa.maxWallClockMinutesPerAttempt,
  };
}

export const SwordfishStoreLayer: Layer.Layer<SwordfishStore, never, SqlClient.SqlClient | SwordfishConfiguration> =
  Layer.effect(SwordfishStore)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* SwordfishConfiguration;

      const bumpRevision = (at: Timestamp) =>
        sql`UPDATE workflow_state SET state_revision = state_revision + 1, updated_at = ${timestampToIso(at)} WHERE singleton = 1`.pipe(
          Effect.asVoid,
        );

      const initialize = (at: Timestamp) => {
        const state = makeInitialSwordfishWorkflowState();
        return sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT OR IGNORE INTO workflow_state (singleton, state_revision, snapshot, updated_at)
            VALUES (1, 0, ${JSON.stringify(encodeWorkflowSnapshot(toWorkflowSnapshot(state)))}, ${timestampToIso(at)})
          `;
            yield* sql`
            INSERT OR IGNORE INTO daemon_metadata
              (singleton, bounty_id, vm_id, repository, assigned_branch, acknowledged_through,
               last_contact_at, last_applied_command_id, connected)
            VALUES (
              1, ${config.bountyId}, ${config.vmId}, ${config.repository}, ${config.assignedBranch},
              0, NULL, NULL, 0
            )
          `;
            const identityRows = yield* sql`
            SELECT bounty_id, vm_id, repository, assigned_branch FROM daemon_metadata WHERE singleton = 1
          `;
            const identity = identityRows[0] as Row;
            for (const [field, configured, stored] of [
              ["bountyId", config.bountyId, text(identity, "bounty_id")],
              ["vmId", config.vmId, text(identity, "vm_id")],
              ["repository", config.repository, text(identity, "repository")],
              ["assignedBranch", config.assignedBranch, text(identity, "assigned_branch")],
            ] as const) {
              if (configured !== stored) {
                return yield* Effect.fail(new AuthorityIdentityError({ field, configured, stored }));
              }
            }
            const defaults = constraintDefaults();
            for (const constraint of constraintKeys) {
              yield* sql`
              INSERT OR IGNORE INTO constraint_ledger
                (constraint_key, consumed, limit_value, extensions_granted, updated_at)
              VALUES (${constraint}, 0, ${defaults[constraint]}, 0, ${timestampToIso(at)})
            `;
            }
          }),
        );
      };

      const loadWorkflow = sql`
      SELECT state_revision, snapshot FROM workflow_state WHERE singleton = 1
    `.pipe(
        Effect.map((rows) => {
          const row = rows[0] as Row | undefined;
          if (row === undefined) throw new Error("Swordfish workflow state is not initialized");
          return {
            stateRevision: number(row, "state_revision"),
            state: fromWorkflowSnapshot(decodeWorkflowSnapshot(JSON.parse(text(row, "snapshot")) as unknown)),
          };
        }),
      );

      const appendEntityRows = (message: EventMessage) => {
        const at = timestampToIso(message.occurredAt);
        const event = message.event;
        switch (event.type) {
          case "cowboy_activated":
            return sql`
            INSERT INTO seats (seat_id, role, created_at, updated_at)
            VALUES (${event.seatId}, ${event.seat}, ${at}, ${at})
            ON CONFLICT (seat_id) DO UPDATE SET updated_at = excluded.updated_at
          `.pipe(Effect.asVoid);
          case "effective_spec_set":
            return sql`
            INSERT INTO effective_specs (revision, payload, created_at)
            VALUES (${event.spec.revision}, ${JSON.stringify(event.spec)}, ${at})
          `.pipe(Effect.asVoid);
          case "candidate_submitted":
            return sql`
            INSERT INTO candidates (commit_sha, spec_revision, payload, submitted_at)
            VALUES (${event.candidate.commitSha}, ${event.candidate.specRevision}, ${JSON.stringify(event.candidate)}, ${at})
          `.pipe(Effect.asVoid);
          case "candidate_invalidated":
            return sql`
            UPDATE candidates SET invalidated_at = ${at}
            WHERE commit_sha = ${event.candidateSha} AND spec_revision = ${event.specRevision}
          `.pipe(Effect.asVoid);
          case "gate_completed":
            return Effect.gen(function* () {
              yield* sql`
              INSERT INTO validator_outcomes
                (sequence, gate, candidate_sha, spec_revision, outcome, payload, occurred_at)
              VALUES (
                ${message.sequence}, ${event.gate}, ${event.candidateSha}, ${event.specRevision}, ${event.outcome},
                ${event.feedback === undefined ? null : JSON.stringify(event.feedback)}, ${at}
              )
            `;
              if (event.feedback !== undefined) {
                yield* sql`
                INSERT INTO findings (event_sequence, gate, payload)
                VALUES (${message.sequence}, ${event.gate}, ${JSON.stringify(event.feedback)})
              `;
              }
            });
          default:
            return Effect.void;
        }
      };

      const appendEvent = (message: EventMessage, state: SwordfishWorkflowState) => {
        const payload = JSON.stringify(encodeEvent(message));
        return Effect.gen(function* () {
          yield* sql`
          INSERT INTO workflow_events (sequence, occurred_at, fingerprint, payload)
          VALUES (${message.sequence}, ${timestampToIso(message.occurredAt)}, ${eventFingerprint(message)}, ${payload})
        `;
          yield* sql`
          INSERT INTO bebop_outbox (sequence, payload, acknowledged) VALUES (${message.sequence}, ${payload}, 0)
        `;
          yield* appendEntityRows(message);
          yield* sql`
          UPDATE workflow_state
          SET state_revision = state_revision + 1,
              snapshot = ${JSON.stringify(encodeWorkflowSnapshot(toWorkflowSnapshot(state)))},
              updated_at = ${timestampToIso(message.occurredAt)}
          WHERE singleton = 1
        `;
        });
      };

      const eventsAfter = (after: EventSequence, limit = 64) =>
        sql`
        SELECT payload FROM bebop_outbox
        WHERE sequence > ${after}
        ORDER BY sequence
        LIMIT ${limit}
      `.pipe(Effect.map((rows) => rows.map((row) => decodeEvent(JSON.parse(text(row as Row, "payload")) as unknown))));

      const deliveryState = sql.withTransaction(
        Effect.gen(function* () {
          const workflow = yield* loadWorkflow;
          const rows = yield* sql`
        SELECT acknowledged_through, last_applied_command_id FROM daemon_metadata WHERE singleton = 1
      `;
          const row = rows[0] as Row;
          const lastAppliedCommandId = optionalText(row, "last_applied_command_id") as CommandId | undefined;
          return {
            lastProduced: workflow.state.lastAppliedSequence,
            acknowledgedThrough: number(row, "acknowledged_through") as EventSequence,
            ...(lastAppliedCommandId === undefined ? {} : { lastAppliedCommandId }),
          };
        }),
      );

      const acknowledge = (through: EventSequence, at: Timestamp) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const workflow = yield* loadWorkflow;
            if (through > workflow.state.lastAppliedSequence) {
              return yield* Effect.fail(
                new AcknowledgementError({
                  acknowledgedThrough: through,
                  lastProduced: workflow.state.lastAppliedSequence,
                }),
              );
            }
            yield* sql`
            UPDATE bebop_outbox
            SET acknowledged = 1, acknowledged_at = ${timestampToIso(at)}
            WHERE sequence <= ${through}
          `;
            yield* sql`
            UPDATE daemon_metadata SET acknowledged_through = max(acknowledged_through, ${through}),
              last_contact_at = ${timestampToIso(at)} WHERE singleton = 1
          `;
            yield* bumpRevision(at);
          }),
        );

      const setConnected = (connected: boolean, at: Timestamp) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            UPDATE daemon_metadata SET connected = ${connected ? 1 : 0}, last_contact_at = ${timestampToIso(at)}
            WHERE singleton = 1
          `;
            yield* bumpRevision(at);
          }),
        );

      const status = (observedAt: Timestamp) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const workflow = yield* loadWorkflow;
            const [metadataRows, seatRows, constraintRows, eventRows, gateRows] = yield* Effect.all([
              sql`SELECT * FROM daemon_metadata WHERE singleton = 1`,
              sql`SELECT role, seat_id FROM seats ORDER BY created_at, role`,
              sql`SELECT * FROM constraint_ledger ORDER BY constraint_key`,
              sql`SELECT sequence, occurred_at, payload FROM workflow_events ORDER BY sequence DESC LIMIT 50`,
              sql`
            SELECT gate, count(*) AS attempts, max(occurred_at) AS updated_at
            FROM validator_outcomes
            WHERE candidate_sha = ${workflow.state.candidate?.commitSha ?? ""}
              AND spec_revision = ${workflow.state.candidate?.specRevision ?? 0}
            GROUP BY gate
          `,
            ]);
            const metadata = metadataRows[0] as Row;
            const attempts = new Map(
              gateRows.map((row) => [
                text(row as Row, "gate"),
                { count: number(row as Row, "attempts"), at: text(row as Row, "updated_at") },
              ]),
            );
            const candidate = workflow.state.candidate;
            const gates =
              candidate === null
                ? []
                : Object.entries(workflow.state.gates).map(([gate, value]) => ({
                    gate,
                    candidateSha: candidate.commitSha,
                    specRevision: candidate.specRevision,
                    status: value.status,
                    attempts: attempts.get(gate)?.count ?? 0,
                    updatedAt: attempts.get(gate)?.at ?? timestampToIso(observedAt),
                  }));
            const pending = yield* sql`SELECT count(*) AS count FROM bebop_outbox WHERE acknowledged = 0`;
            const seats = seatRows.map((row) => ({
              role: text(row as Row, "role"),
              seatId: text(row as Row, "seat_id"),
            }));
            // The active cowboy comes from the workflow state, not from scanning the seat table. The table is a
            // history of every seat that ever ran — including repeated roles, since each jet and faye attempt
            // takes a fresh seat — and only one of them is being driven (ADR 0037).
            const activeCowboy = workflow.state.activeCowboy;
            const attention = workflow.state.attention;
            return decodeStatus({
              stateRevision: workflow.stateRevision,
              observedAt: timestampToIso(observedAt),
              bountyId: config.bountyId,
              vmId: config.vmId,
              repository: config.repository,
              assignedBranch: config.assignedBranch,
              stage: workflow.state.stage,
              controller: workflow.state.controller,
              ...(workflow.state.suspendedStage === null ? {} : { suspendedStage: workflow.state.suspendedStage }),
              attention: attention.map((record) => ({
                kind: record.kind,
                reason: record.reason,
                resolutions: resolutionsForAttention[record.kind],
              })),
              ...(workflow.state.effectiveSpec === null
                ? {}
                : { effectiveSpecRevision: workflow.state.effectiveSpec.revision }),
              ...(activeCowboy === null ? {} : { activeCowboy }),
              seats,
              ...(candidate === null ? {} : { candidateSha: candidate.commitSha }),
              gates,
              constraints: constraintRows.map((row) => ({
                constraint: text(row as Row, "constraint_key"),
                consumed: number(row as Row, "consumed"),
                limit: number(row as Row, "limit_value"),
                extensionsGranted: number(row as Row, "extensions_granted"),
              })),
              bebopConnection: {
                state: number(metadata, "connected") === 1 ? "connected" : "disconnected",
                ...(optionalText(metadata, "last_contact_at") === undefined
                  ? {}
                  : { lastContactAt: optionalText(metadata, "last_contact_at") }),
                acknowledgedThrough: number(metadata, "acknowledged_through"),
                pendingEventCount: number(pending[0] as Row, "count"),
              },
              previews: encodePreviews(workflow.state.previews),
              recentEvents: eventRows.toReversed().map((row) => {
                const event = decodeEvent(JSON.parse(text(row as Row, "payload")) as unknown);
                return {
                  sequence: event.sequence,
                  occurredAt: timestampToIso(event.occurredAt),
                  event: encodeSwordfishEvent(event.event),
                };
              }),
            });
          }),
        );

      const command = (commandId: CommandId) =>
        sql`SELECT command_hash, result_payload FROM applied_commands WHERE command_id = ${commandId}`.pipe(
          Effect.map((rows) => {
            const row = rows[0] as Row | undefined;
            return row === undefined
              ? null
              : {
                  commandHash: text(row, "command_hash"),
                  result: decodeCommandResult(JSON.parse(text(row, "result_payload")) as unknown),
                };
          }),
        );

      const recordCommand = (options: {
        readonly commandId: CommandId;
        readonly command: BebopCommand;
        readonly result: CommandResultMessage;
        readonly at: Timestamp;
      }) =>
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO applied_commands
            (command_id, command_hash, command_payload, result_payload, applied_at)
          VALUES (
            ${options.commandId}, ${commandHash(options.command)}, ${JSON.stringify(options.command)},
            ${JSON.stringify(encodeCommandResult(options.result))}, ${timestampToIso(options.at)}
          )
        `;
          yield* sql`
          UPDATE daemon_metadata SET last_applied_command_id = ${options.commandId} WHERE singleton = 1
        `;
        });

      const recordLocalArtifact = (manifest: EvidenceBundleManifest) =>
        sql`
          INSERT INTO local_artifacts (artifact_id, candidate_sha, manifest, created_at)
          VALUES (
            ${manifest.bundleId}, ${manifest.candidateSha},
            ${JSON.stringify(encodeEvidenceManifest(manifest))}, ${timestampToIso(manifest.createdAt)}
          )
        `.pipe(Effect.asVoid);

      const startReconciliation = (resource: ReconciliationResource, at: Timestamp) =>
        sql`
          INSERT INTO reconciliation_records (record_id, kind, path, pid, status, detail, updated_at)
          VALUES (
            ${resource.recordId}, ${resource.kind}, ${resource.path ?? null},
            ${resource.kind === "child_process" ? resource.pid : null}, 'running', NULL, ${timestampToIso(at)}
          )
          ON CONFLICT (record_id) DO UPDATE SET
            kind = excluded.kind,
            path = excluded.path,
            pid = excluded.pid,
            status = 'running',
            detail = NULL,
            updated_at = excluded.updated_at
        `.pipe(Effect.asVoid);

      const completeReconciliation = (recordId: string, detail: string | undefined, at: Timestamp) =>
        sql`
          UPDATE reconciliation_records
          SET status = 'completed', detail = ${detail ?? null}, updated_at = ${timestampToIso(at)}
          WHERE record_id = ${recordId}
        `.pipe(Effect.asVoid);

      const consumeConstraint = (constraint: ConstraintKey, at: Timestamp) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const updated = yield* sql`
              UPDATE constraint_ledger
              SET consumed = consumed + 1, updated_at = ${timestampToIso(at)}
              WHERE constraint_key = ${constraint} AND consumed < limit_value
              RETURNING constraint_key
            `;
            if (updated.length === 0) return false;
            yield* bumpRevision(at);
            return true;
          }),
        );

      const extendConstraint = (constraint: ConstraintKey, at: Timestamp) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
            SELECT extensions_granted FROM constraint_ledger WHERE constraint_key = ${constraint}
          `;
            const row = rows[0] as Row | undefined;
            if (row === undefined || number(row, "extensions_granted") >= 1) return false;
            yield* sql`
            UPDATE constraint_ledger
            SET limit_value = limit_value + 1, extensions_granted = 1, updated_at = ${timestampToIso(at)}
            WHERE constraint_key = ${constraint}
          `;
            yield* bumpRevision(at);
            return true;
          }),
        );

      const reconcileLocalState = (at: Timestamp) =>
        Effect.gen(function* () {
          yield* sql`
          UPDATE daemon_metadata SET connected = 0, last_contact_at = NULL WHERE singleton = 1
        `;
          const gaps = yield* sql`
          SELECT events.sequence FROM workflow_events AS events
          LEFT JOIN bebop_outbox AS outbox ON outbox.sequence = events.sequence
          WHERE outbox.sequence IS NULL
        `;
          if (gaps.length > 0) {
            throw new Error(`The Bebop outbox is missing ${gaps.length} committed workflow event(s).`);
          }

          const records = yield* sql`
          SELECT record_id, kind, path, pid FROM reconciliation_records WHERE status = 'running'
          `;
          let uncertainRecords = 0;
          for (const record of records) {
            const row = record as Row;
            const kind = text(row, "kind");
            const path = optionalText(row, "path");
            const pidValue = row["pid"];
            let stillPresent = false;
            if (kind === "child_process" && typeof pidValue === "number") {
              stillPresent = yield* Effect.sync(() => {
                try {
                  process.kill(pidValue, 0);
                  return true;
                } catch (cause) {
                  return (cause as NodeJS.ErrnoException).code === "EPERM";
                }
              });
            } else if (path !== undefined) {
              stillPresent = yield* Effect.promise(async () => {
                try {
                  await lstat(path);
                  return true;
                } catch (cause) {
                  if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
                  throw cause;
                }
              });
            }
            const detail = stillPresent
              ? "Resource survived restart; completion is unproven and requires attention"
              : "Resource is absent after restart; previous completion is unknown";
            yield* sql`
            UPDATE reconciliation_records
            SET status = ${stillPresent ? "needs_attention" : "unknown"}, detail = ${detail},
                updated_at = ${timestampToIso(at)}
            WHERE record_id = ${text(row, "record_id")}
          `;
            uncertainRecords += 1;
          }
          return { uncertainRecords };
        });

      return {
        initialize,
        loadWorkflow,
        appendEvent,
        eventsAfter,
        deliveryState,
        acknowledge,
        setConnected,
        status,
        command,
        recordCommand,
        recordLocalArtifact,
        startReconciliation,
        completeReconciliation,
        consumeConstraint,
        extendConstraint,
        reconcileLocalState,
      };
    }),
  );

export { commandHash };
