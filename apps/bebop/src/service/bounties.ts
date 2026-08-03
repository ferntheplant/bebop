// The bounty application service: everything the HTTP handlers do, minus the HTTP.
//
// Handlers stay thin so that the same operations are reachable from the worker and from
// tests without going through a socket, and so the rule in `ABSTRACT.md` §3.3 — that no client
// can do anything the API cannot — has one implementation to be true of.

import type {
  AttachmentSnapshot,
  BountyDetail,
  BountyId,
  BountyListCursor,
  BountySummary,
  CreateBountyRequest,
  GitSha,
  IdempotencyKey,
  Timestamp,
} from "@bebop/contracts";
import {
  BountyListCursor as BountyListCursorSchema,
  GitRef as GitRefSchema,
  resolutionsForAttention,
} from "@bebop/contracts";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql";

import { BebopConfiguration } from "#src/config.ts";
import type { BountyRecord } from "#src/domain/bounty.ts";
import { assignedBranchFor, deriveBountyStatus } from "#src/domain/bounty.ts";
import { Identity, timestampFrom, timestampToIso } from "#src/domain/identity.ts";
import { BountyRepository } from "#src/persistence/bounties.ts";
import { BountyEventRepository } from "#src/persistence/events.ts";
import { fingerprintRequest, IdempotencyRepository } from "#src/persistence/idempotency.ts";
import { LifecycleJobRepository } from "#src/persistence/jobs.ts";
import { SwordfishProjectionRepository } from "#src/persistence/swordfish.ts";

/** A request that cannot be served, distinguished from a database failure. */
export type BountyServiceError =
  | { readonly _tag: "BountyNotFound"; readonly bountyId: BountyId }
  | { readonly _tag: "IdempotencyConflict"; readonly key: IdempotencyKey }
  | { readonly _tag: "InvalidCursor" }
  | { readonly _tag: "IllegalTransition"; readonly bountyId: BountyId; readonly reason: string };

const decodeGitRef = Schema.decodeUnknownSync(GitRefSchema);
const decodeListCursor = Schema.decodeUnknownSync(BountyListCursorSchema);

/**
 * The list cursor: the sort key of the last row on the previous page.
 *
 * Keyset rather than offset, so a bounty created while a client is paging cannot make it
 * skip a row. Base64url keeps it inside `BountyListCursor`'s alphabet and out of query-string
 * escaping.
 */
export function encodeListCursor(bounty: BountyRecord): BountyListCursor {
  const payload = JSON.stringify([timestampToIso(bounty.createdAt), bounty.bountyId]);
  return decodeListCursor(Buffer.from(payload, "utf8").toString("base64url"));
}

export function decodeListCursorValue(
  cursor: BountyListCursor,
): { readonly createdAt: Timestamp; readonly bountyId: BountyId } | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2) {
      return null;
    }
    const [createdAt, bountyId] = decoded as ReadonlyArray<unknown>;
    if (typeof createdAt !== "string" || typeof bountyId !== "string") {
      return null;
    }
    return { createdAt: timestampFrom(createdAt), bountyId: bountyId as BountyId };
  } catch {
    return null;
  }
}

export interface CreatedBounty {
  readonly detail: BountyDetail;
  /** True when the idempotency key matched an earlier request and nothing new was created. */
  readonly replayed: boolean;
}

/** The list view: identity, status, and freshness, without attachment or attention detail. */
export const bountySummary = Effect.fnUntraced(function* (bounty: BountyRecord) {
  const detail = yield* bountyDetail(bounty);
  const {
    attachment: _attachment,
    attention: _attention,
    suspendedStage: _suspendedStage,
    readinessClaimSha: _sha,
    ...summary
  } = detail;
  return summary satisfies BountySummary;
});

/** Assembles the client-visible view of a bounty from the three tables that describe it. */
export const bountyDetail = Effect.fnUntraced(function* (bounty: BountyRecord) {
  const projections = yield* SwordfishProjectionRepository;
  const bounties = yield* BountyRepository;

  const projection = yield* projections.loadIfPresent(bounty.bountyId);
  const attachment = yield* bounties.attachment(bounty.bountyId);
  const stage = projection?.stage ?? null;

  const summary: BountySummary = {
    bountyId: bounty.bountyId,
    repository: bounty.repository,
    baseRef: bounty.baseRef,
    assignedBranch: bounty.assignedBranch,
    status: deriveBountyStatus(
      bounty.lifecycleState,
      stage,
      projection?.controller ?? "swordfish",
      projection?.freshness.status ?? "never_connected",
    ),
    ...(stage === null ? {} : { swordfishStage: stage }),
    controller: projection?.controller ?? "swordfish",
    swordfishFreshness: projection?.freshness.status ?? "never_connected",
    ...(projection?.candidate == null ? {} : { candidateSha: projection.candidate.commitSha }),
    ...(projection?.effectiveSpec == null ? {} : { specRevision: projection.effectiveSpec.revision }),
    createdAt: bounty.createdAt,
    updatedAt: bounty.updatedAt,
  };

  const attachmentSnapshot: AttachmentSnapshot | undefined =
    attachment === null || attachment.destroyedAt !== undefined
      ? undefined
      : {
          ...(attachment.ssh === undefined ? {} : { ssh: attachment.ssh }),
          previews: projection?.previews ?? attachment.previews,
          updatedAt: attachment.updatedAt,
        };

  const detail: BountyDetail = {
    ...summary,
    ...(attachmentSnapshot === undefined ? {} : { attachment: attachmentSnapshot }),
    ...(projection?.readinessClaim == null ? {} : { readinessClaimSha: projection.readinessClaim.candidateSha }),
    ...(projection?.suspendedStage == null ? {} : { suspendedStage: projection.suspendedStage }),
    attention: (projection?.attention ?? []).map((record) => ({
      kind: record.kind,
      reason: record.reason,
      resolutions: resolutionsForAttention[record.kind],
    })),
  };
  return detail;
});

/** Reads a bounty or fails with the typed not-found the handlers translate to a 404. */
export const requireBounty = Effect.fnUntraced(function* (bountyId: BountyId) {
  const bounties = yield* BountyRepository;
  const bounty = yield* bounties.get(bountyId);
  if (bounty === null) {
    return yield* Effect.fail({ _tag: "BountyNotFound", bountyId } as const);
  }
  return bounty;
});

/**
 * Creates a bounty, or replays the one an earlier request with this key created.
 *
 * The bounty row, its idempotency key, its provisioning job, and its first event are written
 * in one transaction. That is what makes the exit criterion true: there is no window in
 * which a bounty exists without the job that provisions it, or in which two requests sharing
 * a key both enqueue work.
 */
export const createBounty = Effect.fnUntraced(function* (options: {
  readonly request: CreateBountyRequest;
  readonly idempotencyKey: IdempotencyKey;
}) {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* Identity;
  const bounties = yield* BountyRepository;
  const idempotency = yield* IdempotencyRepository;
  const jobs = yield* LifecycleJobRepository;
  const events = yield* BountyEventRepository;

  const requestFingerprint = fingerprintRequest(options.request);

  const replay = Effect.fnUntraced(function* (existing: {
    readonly requestFingerprint: string;
    readonly bountyId: BountyId | null;
  }) {
    if (existing.requestFingerprint !== requestFingerprint || existing.bountyId === null) {
      return yield* Effect.fail({ _tag: "IdempotencyConflict", key: options.idempotencyKey } as const);
    }
    const bounty = yield* requireBounty(existing.bountyId);
    const detail = yield* bountyDetail(bounty);
    return { detail, replayed: true } satisfies CreatedBounty;
  });

  const existing = yield* idempotency.find({ scope: "create_bounty", key: options.idempotencyKey });
  if (existing !== null) {
    return yield* replay(existing);
  }

  const bountyId = yield* identity.bountyId;
  const jobId = yield* identity.jobId;
  const now = yield* identity.now;

  const attempt = yield* Effect.result(
    sql.withTransaction(
      Effect.gen(function* () {
        // The bounty row goes in before the key that references it. `idempotency_keys`
        // carries a foreign key to `bounties`, so claiming first would fail on the
        // constraint; and because both writes share one transaction, losing the race below
        // discards this bounty rather than orphaning it.
        const bounty: BountyRecord = {
          bountyId,
          repository: options.request.repository,
          baseRef: options.request.baseRef,
          assignedBranch: decodeGitRef(assignedBranchFor(bountyId)),
          computeProfile: options.request.computeProfile,
          primaryContext: options.request.primaryContext,
          ...(options.request.initialPrompt === undefined ? {} : { initialPrompt: options.request.initialPrompt }),
          lifecycleState: "provisioning",
          createdAt: now,
          updatedAt: now,
        };
        yield* bounties.insert(bounty);

        const claimed = yield* idempotency.claim({
          scope: "create_bounty",
          key: options.idempotencyKey,
          requestFingerprint,
          bountyId,
          createdAt: now,
        });
        if (claimed === null) {
          // Another request holds the key. Failing rather than returning is what rolls this
          // transaction back: the winner's bounty is the answer, and this one must leave no
          // trace.
          return yield* Effect.fail({ _tag: "IdempotencyRaceLost" } as const);
        }

        yield* jobs.enqueue({
          jobId,
          dedupeKey: `provision:${bountyId}`,
          bountyId,
          kind: "provision",
          payload: { computeProfile: bounty.computeProfile },
          at: now,
        });
        yield* events.append({
          bountyId,
          occurredAt: now,
          event: { type: "bounty_status_changed", status: "provisioning" },
        });
        return bounty;
      }),
    ),
  );

  if (attempt._tag === "Failure") {
    if (attempt.failure._tag !== "IdempotencyRaceLost") {
      return yield* Effect.fail(attempt.failure);
    }
    const winner = yield* idempotency.find({ scope: "create_bounty", key: options.idempotencyKey });
    if (winner === null) {
      return yield* Effect.fail({ _tag: "IdempotencyConflict", key: options.idempotencyKey } as const);
    }
    return yield* replay(winner);
  }
  const created = attempt.success;

  const detail = yield* bountyDetail(created);
  yield* Effect.logInfo("created bounty").pipe(
    Effect.annotateLogs("bounty_id", bountyId),
    Effect.annotateLogs("repository", created.repository),
  );
  return { detail, replayed: false } satisfies CreatedBounty;
});

export const listBounties = Effect.fnUntraced(function* (options: { readonly cursor?: BountyListCursor }) {
  const config = yield* BebopConfiguration;
  const bounties = yield* BountyRepository;

  const before = options.cursor === undefined ? undefined : decodeListCursorValue(options.cursor);
  if (options.cursor !== undefined && before === null) {
    return yield* Effect.fail({ _tag: "InvalidCursor" } as const);
  }

  // One extra row distinguishes "the page is full" from "there is more".
  const page = yield* bounties.list({
    limit: config.bountyPageSize + 1,
    ...(before == null ? {} : { before }),
  });
  const visible = page.slice(0, config.bountyPageSize);
  const summaries = yield* Effect.forEach(visible, (bounty) => bountySummary(bounty));
  const last = visible.at(-1);
  return {
    bounties: summaries,
    ...(page.length > config.bountyPageSize && last !== undefined ? { nextCursor: encodeListCursor(last) } : {}),
  };
});

/**
 * Moves a bounty's lifecycle state and records the status change clients see.
 *
 * The event is appended only when the derived status actually changed, so a client tailing
 * the stream does not receive a run of identical `bounty_status_changed` events for internal
 * transitions it cannot observe.
 */
export const transitionLifecycle = Effect.fnUntraced(function* (options: {
  readonly bountyId: BountyId;
  readonly to: BountyRecord["lifecycleState"];
  readonly detail?: string;
  readonly at: Timestamp;
}) {
  const sql = yield* SqlClient.SqlClient;
  const bounties = yield* BountyRepository;
  const events = yield* BountyEventRepository;
  const projections = yield* SwordfishProjectionRepository;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${options.bountyId})::bigint)`;
      const bounty = yield* requireBounty(options.bountyId);
      const projection = yield* projections.loadIfPresent(options.bountyId);
      const stage = projection?.stage ?? null;
      const controller = projection?.controller ?? "swordfish";
      const freshness = projection?.freshness.status ?? "never_connected";
      const before = deriveBountyStatus(bounty.lifecycleState, stage, controller, freshness);
      const after = deriveBountyStatus(options.to, stage, controller, freshness);

      const updated = yield* bounties.setLifecycleState({
        bountyId: options.bountyId,
        lifecycleState: options.to,
        ...(options.detail === undefined ? {} : { detail: options.detail }),
        updatedAt: options.at,
      });
      if (updated !== null && before !== after) {
        yield* events.append({
          bountyId: options.bountyId,
          occurredAt: options.at,
          event: { type: "bounty_status_changed", status: after },
        });
      }
      return updated ?? bounty;
    }),
  );
});

/** Records an approval for one exact candidate SHA ("`.bebop/**` is permanently privileged" (ADR 0011)). */
export const approveConfig = Effect.fnUntraced(function* (options: {
  readonly bountyId: BountyId;
  readonly candidateSha: GitSha;
}) {
  const identity = yield* Identity;
  const bounties = yield* BountyRepository;
  const bounty = yield* requireBounty(options.bountyId);
  const now = yield* identity.now;
  const recorded = yield* bounties.recordConfigApproval({
    bountyId: bounty.bountyId,
    candidateSha: options.candidateSha,
    approvedAt: now,
  });
  return { bounty, recorded };
});

export type BountyServiceRequirements =
  | SqlClient.SqlClient
  | BebopConfiguration
  | Identity
  | BountyRepository
  | BountyEventRepository
  | IdempotencyRepository
  | LifecycleJobRepository
  | SwordfishProjectionRepository;

export type BountyServiceFailure = BountyServiceError | SqlError.SqlError;
