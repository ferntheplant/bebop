// Bounty records, VM mappings, and SHA-pinned configuration approvals.
//
// These three tables move together often enough that splitting them would mean a caller
// opening a transaction across three services to answer "what is this bounty". They are all
// Bebop-authoritative state (`docs/design/SYSTEM.md` §9.1).

import type {
  BountyId,
  ComputeProfile,
  GitSha,
  PrivatePreviewAttachment,
  SshAttachment,
  Timestamp,
  VmId,
} from "@bebop/contracts";
import {
  BountyId as BountyIdSchema,
  GitRef as GitRefSchema,
  PrivatePreviewAttachment as PrivatePreviewAttachmentSchema,
  RepositorySlug as RepositorySlugSchema,
  SshAttachment as SshAttachmentSchema,
  VmId as VmIdSchema,
} from "@bebop/contracts";
import { PgClient } from "@effect/sql-pg";
import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";

import type { BountyLifecycleState, BountyRecord } from "#src/domain/bounty.ts";
import { bountyLifecycleStates } from "#src/domain/bounty.ts";
import { timestampToIso } from "#src/domain/identity.ts";
import type { Row } from "#src/persistence/rows.ts";
import {
  integer,
  json,
  jsonbParameter,
  oneOf,
  optionalText,
  optionalTimestamp,
  text,
  timestamp,
} from "#src/persistence/rows.ts";

const decodeBountyId = Schema.decodeUnknownSync(BountyIdSchema);
const decodeRepository = Schema.decodeUnknownSync(RepositorySlugSchema);
const decodeGitRef = Schema.decodeUnknownSync(GitRefSchema);
const decodeVmId = Schema.decodeUnknownSync(VmIdSchema);
const decodeSsh = Schema.decodeUnknownSync(SshAttachmentSchema);
const decodePreviews = Schema.decodeUnknownSync(Schema.Array(PrivatePreviewAttachmentSchema));
const encodePreviews = Schema.encodeUnknownSync(Schema.Array(PrivatePreviewAttachmentSchema));

const computeProfiles = ["small", "standard", "large"] as const;

export interface VmAttachmentRecord {
  readonly bountyId: BountyId;
  readonly vmId: VmId;
  readonly ssh?: SshAttachment;
  readonly previews: ReadonlyArray<PrivatePreviewAttachment>;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly destroyedAt?: Timestamp;
}

function toBounty(row: Row): BountyRecord {
  const initialPrompt = optionalText(row, "initial_prompt");
  const lifecycleDetail = optionalText(row, "lifecycle_detail");
  return {
    bountyId: decodeBountyId(text(row, "bounty_id")),
    repository: decodeRepository(text(row, "repository")),
    baseRef: decodeGitRef(text(row, "base_ref")),
    assignedBranch: decodeGitRef(text(row, "assigned_branch")),
    computeProfile: oneOf(row, "compute_profile", computeProfiles) as ComputeProfile,
    primaryContext: json(row, "primary_context") as ReadonlyArray<string>,
    ...(initialPrompt === undefined ? {} : { initialPrompt }),
    lifecycleState: oneOf(row, "lifecycle_state", bountyLifecycleStates) as BountyLifecycleState,
    ...(lifecycleDetail === undefined ? {} : { lifecycleDetail }),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function toVmAttachment(row: Row): VmAttachmentRecord {
  const host = optionalText(row, "ssh_host");
  const user = optionalText(row, "ssh_user");
  const port = row["ssh_port"] === null || row["ssh_port"] === undefined ? undefined : integer(row, "ssh_port");
  const destroyedAt = optionalTimestamp(row, "destroyed_at");
  return {
    bountyId: decodeBountyId(text(row, "bounty_id")),
    vmId: decodeVmId(text(row, "vm_id")),
    ...(host === undefined || user === undefined || port === undefined ? {} : { ssh: decodeSsh({ host, port, user }) }),
    previews: decodePreviews(json(row, "previews")),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
    ...(destroyedAt === undefined ? {} : { destroyedAt }),
  };
}

const bountyColumns = `bounty_id, repository, base_ref, assigned_branch, compute_profile, primary_context,
  initial_prompt, lifecycle_state, lifecycle_detail, created_at, updated_at`;

export interface BountyRepositoryService {
  readonly insert: (bounty: BountyRecord) => Effect.Effect<BountyRecord, SqlError.SqlError>;
  readonly get: (bountyId: BountyId) => Effect.Effect<BountyRecord | null, SqlError.SqlError>;
  /**
   * One page of bounties, newest first.
   *
   * Reads one more row than asked for so the caller can tell "this is the last page" from
   * "there happened to be exactly `limit` left" without a second count query.
   */
  readonly list: (options: {
    readonly limit: number;
    readonly before?: { readonly createdAt: Timestamp; readonly bountyId: BountyId };
  }) => Effect.Effect<ReadonlyArray<BountyRecord>, SqlError.SqlError>;
  readonly setLifecycleState: (options: {
    readonly bountyId: BountyId;
    readonly lifecycleState: BountyLifecycleState;
    readonly detail?: string;
    readonly updatedAt: Timestamp;
  }) => Effect.Effect<BountyRecord | null, SqlError.SqlError>;

  readonly attachment: (bountyId: BountyId) => Effect.Effect<VmAttachmentRecord | null, SqlError.SqlError>;
  /** Records or refreshes the VM mapping. Repeating a provision must not create a second. */
  readonly upsertVm: (options: {
    readonly bountyId: BountyId;
    readonly vmId: VmId;
    readonly ssh: SshAttachment;
    readonly previews: ReadonlyArray<PrivatePreviewAttachment>;
    readonly at: Timestamp;
  }) => Effect.Effect<VmAttachmentRecord, SqlError.SqlError>;
  readonly markVmDestroyed: (options: {
    readonly bountyId: BountyId;
    readonly at: Timestamp;
  }) => Effect.Effect<void, SqlError.SqlError>;

  /** Binds the bounty-scoped Swordfish credential (`docs/design/SYSTEM.md` §18.2) to the bounty. */
  readonly setSwordfishTokenHash: (options: {
    readonly bountyId: BountyId;
    readonly tokenHash: string;
    readonly at: Timestamp;
  }) => Effect.Effect<void, SqlError.SqlError>;
  /** Resolves a credential only together with its still-live authoritative VM mapping. */
  readonly swordfishIdentityForTokenHash: (
    tokenHash: string,
  ) => Effect.Effect<{ readonly bountyId: BountyId; readonly vmId: VmId } | null, SqlError.SqlError>;
  readonly revokeSwordfishToken: (options: {
    readonly bountyId: BountyId;
    readonly at: Timestamp;
  }) => Effect.Effect<void, SqlError.SqlError>;

  readonly recordConfigApproval: (options: {
    readonly bountyId: BountyId;
    readonly candidateSha: GitSha;
    readonly approvedAt: Timestamp;
  }) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly approvedConfigShas: (bountyId: BountyId) => Effect.Effect<ReadonlyArray<string>, SqlError.SqlError>;
}

export class BountyRepository extends Context.Service<BountyRepository, BountyRepositoryService>()(
  "BountyRepository",
) {}

export const BountyRepositoryLayer: Layer.Layer<BountyRepository, never, PgClient.PgClient> = Layer.effect(
  BountyRepository,
)(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    return {
      insert: (bounty) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO bounties (
              bounty_id, repository, base_ref, assigned_branch, compute_profile, primary_context,
              initial_prompt, lifecycle_state, lifecycle_detail, created_at, updated_at
            ) VALUES (
              ${bounty.bountyId}, ${bounty.repository}, ${bounty.baseRef}, ${bounty.assignedBranch},
              ${bounty.computeProfile}, ${jsonbParameter([...bounty.primaryContext])}::jsonb,
              ${bounty.initialPrompt ?? null}, ${bounty.lifecycleState}, ${bounty.lifecycleDetail ?? null},
              ${timestampToIso(bounty.createdAt)}, ${timestampToIso(bounty.updatedAt)}
            )
          `;
          return bounty;
        }),

      get: (bountyId) =>
        sql`SELECT ${sql.literal(bountyColumns)} FROM bounties WHERE bounty_id = ${bountyId}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : toBounty(rows[0] as Row))),
        ),

      list: ({ before, limit }) =>
        (before === undefined
          ? sql`
              SELECT ${sql.literal(bountyColumns)} FROM bounties
              ORDER BY created_at DESC, bounty_id DESC
              LIMIT ${limit}
            `
          : sql`
              SELECT ${sql.literal(bountyColumns)} FROM bounties
              WHERE (created_at, bounty_id) < (${timestampToIso(before.createdAt)}, ${before.bountyId})
              ORDER BY created_at DESC, bounty_id DESC
              LIMIT ${limit}
            `
        ).pipe(Effect.map((rows) => rows.map((row) => toBounty(row as Row)))),

      setLifecycleState: ({ bountyId, detail, lifecycleState, updatedAt }) =>
        sql`
          UPDATE bounties
          SET lifecycle_state = ${lifecycleState},
              lifecycle_detail = ${detail ?? null},
              updated_at = ${timestampToIso(updatedAt)}
          WHERE bounty_id = ${bountyId}
          RETURNING ${sql.literal(bountyColumns)}
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toBounty(rows[0] as Row)))),

      attachment: (bountyId) =>
        sql`
          SELECT bounty_id, vm_id, ssh_host, ssh_port, ssh_user, previews, created_at, updated_at, destroyed_at
          FROM vm_mappings WHERE bounty_id = ${bountyId}
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toVmAttachment(rows[0] as Row)))),

      upsertVm: ({ at, bountyId, previews, ssh, vmId }) =>
        sql`
          INSERT INTO vm_mappings (bounty_id, vm_id, ssh_host, ssh_port, ssh_user, previews, created_at, updated_at)
          VALUES (
            ${bountyId}, ${vmId}, ${ssh.host}, ${ssh.port}, ${ssh.user},
            ${jsonbParameter(encodePreviews(previews))}::jsonb, ${timestampToIso(at)}, ${timestampToIso(at)}
          )
          ON CONFLICT (bounty_id) DO UPDATE SET
            vm_id = excluded.vm_id,
            ssh_host = excluded.ssh_host,
            ssh_port = excluded.ssh_port,
            ssh_user = excluded.ssh_user,
            previews = excluded.previews,
            updated_at = excluded.updated_at,
            destroyed_at = NULL
          RETURNING bounty_id, vm_id, ssh_host, ssh_port, ssh_user, previews, created_at, updated_at, destroyed_at
        `.pipe(Effect.map((rows) => toVmAttachment(rows[0] as Row))),

      markVmDestroyed: ({ at, bountyId }) =>
        sql`
          UPDATE vm_mappings
          SET destroyed_at = ${timestampToIso(at)}, updated_at = ${timestampToIso(at)}
          WHERE bounty_id = ${bountyId}
        `.pipe(Effect.asVoid),

      setSwordfishTokenHash: ({ at, bountyId, tokenHash }) =>
        sql`
          UPDATE bounties
          SET swordfish_token_hash = ${tokenHash}, updated_at = ${timestampToIso(at)}
          WHERE bounty_id = ${bountyId}
        `.pipe(Effect.asVoid),

      swordfishIdentityForTokenHash: (tokenHash) =>
        sql`
          SELECT b.bounty_id, vm.vm_id
          FROM bounties b
          JOIN vm_mappings vm ON vm.bounty_id = b.bounty_id AND vm.destroyed_at IS NULL
          WHERE b.swordfish_token_hash = ${tokenHash}
        `.pipe(
          Effect.map((rows) =>
            rows[0] === undefined
              ? null
              : {
                  bountyId: decodeBountyId(text(rows[0] as Row, "bounty_id")),
                  vmId: decodeVmId(text(rows[0] as Row, "vm_id")),
                },
          ),
        ),

      revokeSwordfishToken: ({ at, bountyId }) =>
        sql`
          UPDATE bounties
          SET swordfish_token_hash = NULL, updated_at = ${timestampToIso(at)}
          WHERE bounty_id = ${bountyId}
        `.pipe(Effect.asVoid),

      recordConfigApproval: ({ approvedAt, bountyId, candidateSha }) =>
        sql`
          INSERT INTO config_approvals (bounty_id, candidate_sha, approved_at)
          VALUES (${bountyId}, ${candidateSha}, ${timestampToIso(approvedAt)})
          ON CONFLICT (bounty_id, candidate_sha) DO NOTHING
          RETURNING candidate_sha
        `.pipe(Effect.map((rows) => rows.length === 1)),

      approvedConfigShas: (bountyId) =>
        sql`SELECT candidate_sha FROM config_approvals WHERE bounty_id = ${bountyId} ORDER BY approved_at`.pipe(
          Effect.map((rows) => rows.map((row) => text(row as Row, "candidate_sha"))),
        ),
    };
  }),
);
