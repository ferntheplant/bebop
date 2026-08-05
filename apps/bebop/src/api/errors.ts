// Turning service failures into the typed HTTP errors the contract declares.
//
// There is one mapper per error set an endpoint declares, rather than one mapper producing
// every code. That is not ceremony: `POST /api/bounties` does not declare `404`, and
// `GET /api/bounties` does not declare `409`, so a single wide mapper would either force
// every endpoint to widen its declared errors or fail to type-check. Keeping them separate is
// what makes the generated OpenAPI an accurate list of what a client can actually receive.
//
// Every error body carries a request ID. It is the only handle a user has when a CLI reports
// a failure and the explanation is a log line on the master VM, so it is generated even for
// errors nobody will look up.

import type { ApiRequestId, BountyId, IdempotencyKey } from "@bebop/contracts";
import { ApiRequestId as ApiRequestIdSchema } from "@bebop/contracts";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";

import type { BountyServiceError } from "#src/service/bounties.ts";

const decodeRequestId = Schema.decodeUnknownSync(ApiRequestIdSchema);

export const newRequestId: Effect.Effect<ApiRequestId> = Effect.sync(() =>
  decodeRequestId(`req-${crypto.randomUUID().replaceAll("-", "")}`),
);

interface ApiErrorBody<Code extends string> {
  readonly code: Code;
  readonly message: string;
  readonly requestId: ApiRequestId;
}

function body<const Code extends string>(code: Code, message: string): Effect.Effect<ApiErrorBody<Code>> {
  return Effect.map(newRequestId, (requestId) => ({ code, message, requestId }));
}

const badRequest = (message: string) => body("bad_request" as const, message);
const notFound = (bountyId: BountyId) => body("bounty_not_found" as const, `No bounty with id ${bountyId}.`);
export const tokenNotFound = (message: string) => body("token_not_found" as const, message);
const conflict = (message: string) => body("conflict" as const, message);
export const unprocessable = (message: string) => body("unprocessable_entity" as const, message);
export const internalError = (message: string) => body("internal_error" as const, message);

/**
 * Anything the caller cannot act on, answered without leaking how it went wrong.
 *
 * A SQL message can name a table, a constraint, or a value, none of which belong in a
 * response body. It goes to the log instead, tied to the request ID the client is given.
 */
function unexpected(error: unknown, note: string): Effect.Effect<ApiErrorBody<"internal_error">> {
  return Effect.flatMap(internalError("The request could not be completed."), (payload) =>
    Effect.logError(note).pipe(
      Effect.annotateLogs("request_id", payload.requestId),
      Effect.annotateLogs("error", JSON.stringify(error, Object.getOwnPropertyNames(error as object))),
      Effect.as(payload),
    ),
  );
}

type Failure<Tags extends BountyServiceError["_tag"]> = Extract<BountyServiceError, { _tag: Tags }> | SqlError.SqlError;

const fail = <A>(effect: Effect.Effect<A>): Effect.Effect<never, A> =>
  Effect.flatMap(effect, (value) => Effect.fail(value));

type CreateBountyApiError = ApiErrorBody<"conflict"> | ApiErrorBody<"internal_error">;
type ListBountiesApiError = ApiErrorBody<"bad_request"> | ApiErrorBody<"internal_error">;
type BountyReadApiError = ApiErrorBody<"bounty_not_found"> | ApiErrorBody<"internal_error">;
type BountyMutationApiError = BountyReadApiError | ApiErrorBody<"conflict"> | ApiErrorBody<"unprocessable_entity">;

/** `POST /api/bounties`: a reused key is a conflict; nothing else here is the caller's fault. */
export const failCreateBounty = (
  error: Failure<"IdempotencyConflict" | "BountyNotFound">,
): Effect.Effect<never, CreateBountyApiError> =>
  fail<CreateBountyApiError>(
    error._tag === "IdempotencyConflict"
      ? conflictingKey(error.key)
      : // A stored idempotency key pointing at a bounty that no longer exists is Bebop's
        // inconsistency, not a request the client can fix by asking for a different bounty.
        unexpected(error, "idempotent create could not be replayed"),
  );

/** `GET /api/bounties`: only a cursor this API did not issue is the caller's fault. */
export const failListBounties = (error: Failure<"InvalidCursor">): Effect.Effect<never, ListBountiesApiError> =>
  fail<ListBountiesApiError>(
    error._tag === "InvalidCursor"
      ? badRequest("The pagination cursor is not one this API issued.")
      : unexpected(error, "bounties could not be listed"),
  );

/** Any read scoped to one bounty. */
export const failBountyRead = (error: Failure<"BountyNotFound">): Effect.Effect<never, BountyReadApiError> =>
  fail<BountyReadApiError>(
    error._tag === "BountyNotFound" ? notFound(error.bountyId) : unexpected(error, "bounty could not be read"),
  );

/** Any mutation scoped to one bounty: it may also refuse a transition it cannot make. */
export const failBountyMutation = (
  error: Failure<"BountyNotFound" | "IllegalTransition" | "IdempotencyConflict">,
): Effect.Effect<never, BountyMutationApiError> => {
  switch (error._tag) {
    case "BountyNotFound":
      return fail<BountyMutationApiError>(notFound(error.bountyId));
    case "IllegalTransition":
      return fail<BountyMutationApiError>(unprocessable(error.reason));
    case "IdempotencyConflict":
      return fail<BountyMutationApiError>(conflictingKey(error.key));
    default:
      return fail<BountyMutationApiError>(unexpected(error, "bounty could not be changed"));
  }
};

function conflictingKey(key: IdempotencyKey) {
  return conflict(`Idempotency key ${key} was already used for a different request.`);
}
