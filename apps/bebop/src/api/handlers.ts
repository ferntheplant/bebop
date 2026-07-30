// The HTTP handlers for `BebopHttpApi`.
//
// Every handler is a translation: decoding is already done by the contract, so what is left
// is calling the service and mapping its typed failure onto the typed error the endpoint
// declares. Nothing here decides policy — SPEC section 4.3 requires that a machine client can
// do everything the CLI can, and the way to keep that true is for both to go through the
// service operations rather than for the handlers to hold logic of their own.

import type { BebopCommand, BountyId, IdempotencyKey } from "@bebop/contracts";
import { BebopHttpApi } from "@bebop/contracts";
import { Effect, Redacted, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql";

import {
  failBountyMutation,
  failBountyRead,
  failCreateBounty,
  failListBounties,
  internalError,
  tokenNotFound,
  unprocessable,
} from "#src/api/errors.ts";
import { bountyEventStream } from "#src/api/event-stream.ts";
import { Identity } from "#src/domain/identity.ts";
import { BountyRepository } from "#src/persistence/bounties.ts";
import { CommandRepository } from "#src/persistence/commands.ts";
import { LifecycleJobRepository } from "#src/persistence/jobs.ts";
import { ApiTokenRepository } from "#src/persistence/tokens.ts";
import {
  approveConfig,
  bountyDetail,
  createBounty,
  listBounties,
  requireBounty,
  transitionLifecycle,
} from "#src/service/bounties.ts";

/**
 * Queues a Bebop command for Swordfish.
 *
 * The command is durable before this returns, so a Swordfish that is offline — or a Bebop
 * that restarts a second later — still delivers it (SPEC section 18.4).
 */
const enqueueCommand = Effect.fnUntraced(function* (options: {
  readonly bountyId: BountyId;
  readonly command: BebopCommand;
}) {
  const identity = yield* Identity;
  const commands = yield* CommandRepository;
  const commandId = yield* identity.commandId;
  const now = yield* identity.now;
  yield* commands.enqueue({ commandId, bountyId: options.bountyId, command: options.command, issuedAt: now });
});

export const HealthHandlers = HttpApiBuilder.group(BebopHttpApi, "health", (handlers) =>
  handlers.handle("health", () =>
    Effect.gen(function* () {
      const identity = yield* Identity;
      const checkedAt = yield* identity.now;
      return { status: "ok" as const, checkedAt };
    }),
  ),
);

export const BountyHandlers = HttpApiBuilder.group(BebopHttpApi, "bounties", (handlers) =>
  handlers
    .handle("createBounty", ({ headers, payload }) =>
      createBounty({ request: payload, idempotencyKey: headers["idempotency-key"] as IdempotencyKey }).pipe(
        Effect.map((created) => created.detail),
        Effect.catch(failCreateBounty),
      ),
    )

    .handle("listBounties", ({ query }) =>
      listBounties(query.cursor === undefined ? {} : { cursor: query.cursor }).pipe(Effect.catch(failListBounties)),
    )

    .handle("getBounty", ({ params }) =>
      requireBounty(params.bountyId).pipe(Effect.flatMap(bountyDetail), Effect.catch(failBountyRead)),
    )

    .handle("streamBountyEvents", ({ headers, params }) =>
      Effect.gen(function* () {
        // `Last-Event-ID` is the only cursor source, so a client cannot ask for one range in
        // a header and a different one in a query parameter.
        const afterCursor = headers["last-event-id"] === undefined ? 0 : Number(headers["last-event-id"]);
        yield* requireBounty(params.bountyId);
        const stream = yield* bountyEventStream({ bountyId: params.bountyId, afterCursor });
        // A failure after the first byte cannot become a status code, so it is reported on
        // the declared in-band error frame instead of silently truncating the stream.
        return stream.pipe(
          Stream.catchCause((cause) =>
            Stream.fromEffect(
              Effect.logError("bounty event stream failed", cause).pipe(
                Effect.annotateLogs("bounty_id", params.bountyId),
                Effect.andThen(
                  Effect.fail({ code: "stream_error" as const, message: "The event stream could not continue." }),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.catch(failBountyRead)),
    )

    .handle("getBountyAttachments", ({ params }) =>
      Effect.gen(function* () {
        const bounties = yield* BountyRepository;
        yield* requireBounty(params.bountyId);
        const attachment = yield* bounties.attachment(params.bountyId);
        if (attachment === null || attachment.destroyedAt !== undefined) {
          // 404 rather than a conflict: this route's contract declares no conflict, and a
          // bounty with no live computer genuinely has no attachment resource to return.
          return yield* Effect.fail({ _tag: "BountyNotFound" as const, bountyId: params.bountyId });
        }
        return {
          ...(attachment.ssh === undefined ? {} : { ssh: attachment.ssh }),
          previews: attachment.previews,
          updatedAt: attachment.updatedAt,
        };
      }).pipe(Effect.catch(failBountyRead)),
    )

    .handle("getBountyEvidence", ({ params }) =>
      // Evidence ingestion lands in Milestone 10. An empty bundle list is the honest answer
      // for a bounty that has uploaded none, which today is every bounty; the route exists so
      // the contract is whole and clients can be written against it now.
      requireBounty(params.bountyId).pipe(
        Effect.as({ bundles: [] as ReadonlyArray<never> }),
        Effect.catch(failBountyRead),
      ),
    )

    .handle("approveConfig", ({ params, payload }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const bounty = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${params.bountyId})::bigint)`;
            const approved = yield* approveConfig({
              bountyId: params.bountyId,
              candidateSha: payload.candidateSha,
            });
            if (approved.recorded) {
              yield* enqueueCommand({
                bountyId: params.bountyId,
                command: { type: "approve_config", candidateSha: payload.candidateSha },
              });
            }
            return approved.bounty;
          }),
        );
        return yield* bountyDetail(bounty);
      }).pipe(Effect.catch(failBountyMutation)),
    )

    .handle("mergeBounty", ({ params }) =>
      // Merge authority is Bebop's (SPEC section 9.1) and needs GitHub, which Milestone 3
      // deliberately does not have. Refusing is the only honest answer: a success here would
      // claim an external side effect that never happened.
      requireBounty(params.bountyId).pipe(
        Effect.flatMap(() =>
          Effect.fail({
            _tag: "IllegalTransition" as const,
            bountyId: params.bountyId,
            reason: "Merging requires the GitHub integration, which this Bebop does not have yet.",
          }),
        ),
        Effect.catch(failBountyMutation),
      ),
    )

    .handle("stopBounty", ({ params, payload }) =>
      Effect.gen(function* () {
        const identity = yield* Identity;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* identity.now;
        const stopped = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${params.bountyId})::bigint)`;
            const bounty = yield* requireBounty(params.bountyId);
            if (["stopping", "stopped", "destroying", "destroyed", "done"].includes(bounty.lifecycleState)) {
              return bounty;
            }
            yield* enqueueCommand({
              bountyId: bounty.bountyId,
              command: { type: "stop", ...(payload.reason === undefined ? {} : { reason: payload.reason }) },
            });
            return yield* transitionLifecycle({
              bountyId: bounty.bountyId,
              to: "stopping",
              ...(payload.reason === undefined ? {} : { detail: payload.reason }),
              at: now,
            });
          }),
        );
        return yield* bountyDetail(stopped);
      }).pipe(Effect.catch(failBountyMutation)),
    )

    .handle("recoverBounty", ({ params }) =>
      Effect.gen(function* () {
        const identity = yield* Identity;
        const jobs = yield* LifecycleJobRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* identity.now;
        const recovering = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${params.bountyId})::bigint)`;
            const bounty = yield* requireBounty(params.bountyId);
            if (bounty.lifecycleState === "destroyed" || bounty.lifecycleState === "destroying") {
              return yield* Effect.fail({
                _tag: "IllegalTransition" as const,
                bountyId: bounty.bountyId,
                reason: "A destroyed bounty cannot be recovered.",
              });
            }
            const job = yield* jobs.requeue({ dedupeKey: `provision:${bounty.bountyId}`, at: now });
            if (job === null) {
              return yield* Effect.die(new Error(`Bounty ${bounty.bountyId} has no provisioning job`));
            }
            return yield* transitionLifecycle({ bountyId: bounty.bountyId, to: "provisioning", at: now });
          }),
        );
        return yield* bountyDetail(recovering);
      }).pipe(Effect.catch(failBountyMutation)),
    )

    .handle("destroyBounty", ({ params }) =>
      Effect.gen(function* () {
        const identity = yield* Identity;
        const jobs = yield* LifecycleJobRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* identity.now;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${params.bountyId})::bigint)`;
            const bounty = yield* requireBounty(params.bountyId);
            if (bounty.lifecycleState === "destroying" || bounty.lifecycleState === "destroyed") {
              return;
            }
            const jobId = yield* identity.jobId;
            yield* jobs.enqueue({
              jobId,
              dedupeKey: `destroy:${bounty.bountyId}`,
              bountyId: bounty.bountyId,
              kind: "destroy",
              payload: {},
              at: now,
            });
            yield* transitionLifecycle({ bountyId: bounty.bountyId, to: "destroying", at: now });
          }),
        );
      }).pipe(Effect.catch(failBountyMutation)),
    ),
);

export const TokenHandlers = HttpApiBuilder.group(BebopHttpApi, "tokens", (handlers) =>
  handlers
    .handle("createToken", ({ payload }) =>
      Effect.gen(function* () {
        const identity = yield* Identity;
        const tokens = yield* ApiTokenRepository;
        const tokenId = yield* identity.apiTokenId;
        const secret = yield* identity.apiTokenSecret;
        const createdAt = yield* identity.now;
        const result = yield* Effect.result(tokens.create({ tokenId, name: payload.name, secret, createdAt }));
        if (result._tag === "Failure") {
          const error = result.failure;
          if (error.reason._tag === "UniqueViolation" && error.reason.constraint === "api_tokens_name_key") {
            return yield* Effect.flatMap(unprocessable(`A token named ${payload.name} already exists.`), Effect.fail);
          }
          return yield* Effect.flatMap(internalError("The token could not be created."), (body) =>
            Effect.logError("token creation failed", error).pipe(
              Effect.annotateLogs("request_id", body.requestId),
              Effect.andThen(Effect.fail(body)),
            ),
          );
        }
        const token = result.success;
        // The one moment the plaintext exists outside the client's own configuration.
        return { token, secret: Redacted.make(secret, { label: "api-token-secret" }) };
      }),
    )

    .handle("listTokens", () =>
      Effect.gen(function* () {
        const tokens = yield* ApiTokenRepository;
        const list = yield* tokens.list.pipe(
          Effect.catch(() => Effect.flatMap(internalError("Tokens could not be listed."), Effect.fail)),
        );
        return { tokens: list };
      }),
    )

    .handle("revokeToken", ({ params }) =>
      Effect.gen(function* () {
        const identity = yield* Identity;
        const tokens = yield* ApiTokenRepository;
        const revokedAt = yield* identity.now;
        const revoked = yield* tokens
          .revoke({ tokenId: params.tokenId, revokedAt })
          .pipe(Effect.catch(() => Effect.flatMap(internalError("The token could not be revoked."), Effect.fail)));
        if (revoked === null) {
          return yield* Effect.flatMap(tokenNotFound(`No token with id ${params.tokenId}.`), Effect.fail);
        }
        return revoked;
      }),
    ),
);
