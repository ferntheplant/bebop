import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/unstable/httpapi";

import { AttachmentSnapshot } from "./attachments.ts";
import { EvidenceArtifactPath, EvidenceBundleManifest } from "./evidence.ts";
import { SwordfishEvent } from "./protocol.ts";
import {
  ApiRequestId,
  ApiTokenId,
  ApiTokenName,
  ApiTokenSecret,
  BountyEventCursor,
  BountyEventCursorString,
  BountyId,
  BountyListCursor,
  GitRef,
  GitSha,
  HttpsUrl,
  IdempotencyKey,
  RepositorySlug,
  SpecRevision,
  Timestamp,
} from "./scalars.ts";
import { BountyStatus, SwordfishStage } from "./workflow.ts";

const Message = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4_000), Schema.isTrimmed()));
const ContextCapability = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100), Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
);

export const ComputeProfile = Schema.Literals(["small", "standard", "large"]);
export type ComputeProfile = typeof ComputeProfile.Type;

export const SwordfishFreshnessStatus = Schema.Literals(["never_connected", "connected", "disconnected", "stale"]);
export type SwordfishFreshnessStatus = typeof SwordfishFreshnessStatus.Type;

export const CreateBountyRequest = Schema.Struct({
  repository: RepositorySlug,
  baseRef: GitRef,
  computeProfile: ComputeProfile,
  primaryContext: Schema.Array(ContextCapability),
  initialPrompt: Schema.optionalKey(Message),
});
export type CreateBountyRequest = typeof CreateBountyRequest.Type;

export const BountySummary = Schema.Struct({
  bountyId: BountyId,
  repository: RepositorySlug,
  baseRef: GitRef,
  assignedBranch: GitRef,
  status: BountyStatus,
  swordfishStage: Schema.optionalKey(SwordfishStage),
  swordfishFreshness: SwordfishFreshnessStatus,
  candidateSha: Schema.optionalKey(GitSha),
  specRevision: Schema.optionalKey(SpecRevision),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type BountySummary = typeof BountySummary.Type;

export const BountyDetail = Schema.Struct({
  ...BountySummary.fields,
  attachment: Schema.optionalKey(AttachmentSnapshot),
  readinessClaimSha: Schema.optionalKey(GitSha),
  attentionReason: Schema.optionalKey(Message),
});
export type BountyDetail = typeof BountyDetail.Type;

export const CreateBountyResponse = BountyDetail.pipe(HttpApiSchema.status("Created"));
export const ListBountiesResponse = Schema.Struct({
  bounties: Schema.Array(BountySummary),
  nextCursor: Schema.optionalKey(BountyListCursor),
});
export const GetBountyResponse = BountyDetail;
export const BountyAttachmentsResponse = AttachmentSnapshot;
export const EvidenceArtifactDownload = Schema.Struct({ path: EvidenceArtifactPath, downloadUrl: HttpsUrl });
const EvidenceBundleDownloadBase = Schema.Struct({
  manifest: EvidenceBundleManifest,
  artifacts: Schema.Array(EvidenceArtifactDownload),
});
export const EvidenceBundleDownload = EvidenceBundleDownloadBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof EvidenceBundleDownloadBase.Type>((bundle) => {
      const manifestPaths = bundle.manifest.artifacts.map((artifact) => artifact.path).toSorted();
      const downloadPaths = bundle.artifacts.map((artifact) => artifact.path).toSorted();
      return new Set(downloadPaths).size === downloadPaths.length &&
        JSON.stringify(manifestPaths) === JSON.stringify(downloadPaths)
        ? undefined
        : "Expected one download URL for every evidence artifact";
    }),
  ),
);
export const BountyEvidenceResponse = Schema.Struct({ bundles: Schema.Array(EvidenceBundleDownload) });

export const ApproveConfigRequest = Schema.Struct({ candidateSha: GitSha });
export const MergeBountyRequest = Schema.Struct({ expectedHeadSha: GitSha });
export const StopBountyRequest = Schema.Struct({ reason: Schema.optionalKey(Message) });
export const BountyActionResponse = BountyDetail.pipe(HttpApiSchema.status("Accepted"));
export const HealthResponse = Schema.Struct({ status: Schema.Literal("ok"), checkedAt: Timestamp });

function errorSchema<const Code extends string>(code: Code, status: HttpApiSchema.StatusLiteral) {
  return Schema.Struct({
    code: Schema.Literal(code),
    message: Message,
    requestId: ApiRequestId,
  }).pipe(HttpApiSchema.status(status));
}

export const BadRequestError = errorSchema("bad_request", "BadRequest");
export const UnauthorizedError = errorSchema("unauthorized", "Unauthorized");
export const BountyNotFoundError = errorSchema("bounty_not_found", "NotFound");
export const ConflictError = errorSchema("conflict", "Conflict");
export const PayloadTooLargeError = errorSchema("payload_too_large", "PayloadTooLarge");
export const UnprocessableEntityError = errorSchema("unprocessable_entity", "UnprocessableEntity");
export const InternalServerError = errorSchema("internal_error", "InternalServerError");

export class BearerAuthentication extends HttpApiMiddleware.Service<BearerAuthentication>()("BearerAuthentication", {
  security: { bearer: HttpApiSecurity.bearer },
  error: UnauthorizedError,
}) {}

const commonErrors = [BadRequestError, UnauthorizedError, InternalServerError] as const;
const bountyErrors = [...commonErrors, BountyNotFoundError] as const;
const mutationErrors = [...bountyErrors, ConflictError, UnprocessableEntityError] as const;

export const BountyLifecycleEvent = Schema.Struct({
  type: Schema.Literal("bounty_status_changed"),
  status: BountyStatus,
});
export const ProjectedSwordfishEvent = Schema.Struct({
  type: Schema.Literal("swordfish_event"),
  event: SwordfishEvent,
});
export const SwordfishFreshnessChangedEvent = Schema.Struct({
  type: Schema.Literal("swordfish_freshness_changed"),
  freshness: SwordfishFreshnessStatus,
});
export const BountyPublicEvent = Schema.Union([
  BountyLifecycleEvent,
  ProjectedSwordfishEvent,
  SwordfishFreshnessChangedEvent,
]);
export const BountyEventEnvelope = Schema.Struct({
  cursor: BountyEventCursor,
  bountyId: BountyId,
  occurredAt: Timestamp,
  event: BountyPublicEvent,
});
export type BountyEventEnvelope = typeof BountyEventEnvelope.Type;

const BountySseEventBase = Schema.Struct({
  id: BountyEventCursorString,
  event: Schema.Literal("bounty_event"),
  data: Schema.fromJsonString(BountyEventEnvelope),
});
export const BountySseEvent = BountySseEventBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof BountySseEventBase.Type>((event) =>
      event.id === String(event.data.cursor) ? undefined : "Expected the SSE ID to match the event cursor",
    ),
  ),
);
export const BountyStreamError = Schema.Struct({ code: Schema.Literal("stream_error"), message: Message });
export const BountyEventStream = HttpApiSchema.StreamSse({ events: BountySseEvent, error: BountyStreamError });

export const HealthEndpoint = HttpApiEndpoint.get("health", "/api/health", { success: HealthResponse });
export const CreateBountyEndpoint = HttpApiEndpoint.post("createBounty", "/api/bounties", {
  headers: { "idempotency-key": IdempotencyKey },
  payload: CreateBountyRequest,
  success: CreateBountyResponse,
  error: [...commonErrors, ConflictError, PayloadTooLargeError, UnprocessableEntityError],
});
export const ListBountiesEndpoint = HttpApiEndpoint.get("listBounties", "/api/bounties", {
  query: { cursor: Schema.optionalKey(BountyListCursor) },
  success: ListBountiesResponse,
  error: commonErrors,
});
export const GetBountyEndpoint = HttpApiEndpoint.get("getBounty", "/api/bounties/:bountyId", {
  params: { bountyId: BountyId },
  success: GetBountyResponse,
  error: bountyErrors,
});
export const StreamBountyEventsEndpoint = HttpApiEndpoint.get("streamBountyEvents", "/api/bounties/:bountyId/events", {
  params: { bountyId: BountyId },
  headers: { "last-event-id": Schema.optionalKey(BountyEventCursorString) },
  success: BountyEventStream,
  error: bountyErrors,
});
export const GetBountyAttachmentsEndpoint = HttpApiEndpoint.get(
  "getBountyAttachments",
  "/api/bounties/:bountyId/attachments",
  { params: { bountyId: BountyId }, success: BountyAttachmentsResponse, error: bountyErrors },
);
export const GetBountyEvidenceEndpoint = HttpApiEndpoint.get("getBountyEvidence", "/api/bounties/:bountyId/evidence", {
  params: { bountyId: BountyId },
  success: BountyEvidenceResponse,
  error: bountyErrors,
});
export const ApproveConfigEndpoint = HttpApiEndpoint.post("approveConfig", "/api/bounties/:bountyId/approve-config", {
  params: { bountyId: BountyId },
  payload: ApproveConfigRequest,
  success: BountyActionResponse,
  error: mutationErrors,
});
export const MergeBountyEndpoint = HttpApiEndpoint.post("mergeBounty", "/api/bounties/:bountyId/merge", {
  params: { bountyId: BountyId },
  payload: MergeBountyRequest,
  success: BountyActionResponse,
  error: mutationErrors,
});
export const StopBountyEndpoint = HttpApiEndpoint.post("stopBounty", "/api/bounties/:bountyId/stop", {
  params: { bountyId: BountyId },
  payload: StopBountyRequest,
  success: BountyActionResponse,
  error: mutationErrors,
});
export const RecoverBountyEndpoint = HttpApiEndpoint.post("recoverBounty", "/api/bounties/:bountyId/recover", {
  params: { bountyId: BountyId },
  success: BountyActionResponse,
  error: mutationErrors,
});
export const DestroyBountyEndpoint = HttpApiEndpoint.delete("destroyBounty", "/api/bounties/:bountyId", {
  params: { bountyId: BountyId },
  error: mutationErrors,
});

export const ApiTokenSummary = Schema.Struct({
  tokenId: ApiTokenId,
  name: ApiTokenName,
  createdAt: Timestamp,
  lastUsedAt: Schema.optionalKey(Timestamp),
  revokedAt: Schema.optionalKey(Timestamp),
});
export type ApiTokenSummary = typeof ApiTokenSummary.Type;

export const CreateTokenRequest = Schema.Struct({ name: ApiTokenName });

/**
 * The only response that carries the secret.
 *
 * Bebop stores tokens hashed (SPEC section 17.4), so the plaintext exists exactly once, in
 * this response. It is `Redacted` so it cannot reach a log through an accidental
 * interpolation, and unlike the process-configuration secrets it does not set
 * `disallowEncode` — this response body *is* its transport boundary. `RedactedFromValue`
 * rather than `Redacted`, because the wire form is a plain string.
 */
export const CreateTokenResponse = Schema.Struct({
  token: ApiTokenSummary,
  secret: Schema.RedactedFromValue(ApiTokenSecret, { label: "api-token-secret" }),
}).pipe(HttpApiSchema.status("Created"));

export const ListTokensResponse = Schema.Struct({ tokens: Schema.Array(ApiTokenSummary) });
export const RevokeTokenResponse = ApiTokenSummary.pipe(HttpApiSchema.status("Accepted"));

export const TokenNotFoundError = errorSchema("token_not_found", "NotFound");

const tokenErrors = [...commonErrors, TokenNotFoundError] as const;

export const CreateTokenEndpoint = HttpApiEndpoint.post("createToken", "/api/tokens", {
  payload: CreateTokenRequest,
  success: CreateTokenResponse,
  error: [...commonErrors, ConflictError, UnprocessableEntityError],
});
export const ListTokensEndpoint = HttpApiEndpoint.get("listTokens", "/api/tokens", {
  success: ListTokensResponse,
  error: commonErrors,
});
export const RevokeTokenEndpoint = HttpApiEndpoint.delete("revokeToken", "/api/tokens/:tokenId", {
  params: { tokenId: ApiTokenId },
  success: RevokeTokenResponse,
  error: tokenErrors,
});

// Health carries no bearer middleware. SPEC section 24 puts health-checked blue/green
// containers behind Caddy, and a liveness probe that needs a credential means baking a
// token into the image or the compose file — a durable secret created solely to ask a
// process whether it is alive. The route exposes only liveness; every route that can read
// or change bounty state is authenticated below.
export const HealthApiGroup = HttpApiGroup.make("health").add(HealthEndpoint);
// `middleware` applies only to the endpoints already added, so it comes last.
export const BountiesApiGroup = HttpApiGroup.make("bounties")
  .add(
    CreateBountyEndpoint,
    ListBountiesEndpoint,
    GetBountyEndpoint,
    StreamBountyEventsEndpoint,
    GetBountyAttachmentsEndpoint,
    GetBountyEvidenceEndpoint,
    ApproveConfigEndpoint,
    MergeBountyEndpoint,
    StopBountyEndpoint,
    RecoverBountyEndpoint,
    DestroyBountyEndpoint,
  )
  .middleware(BearerAuthentication);

export const TokensApiGroup = HttpApiGroup.make("tokens")
  .add(CreateTokenEndpoint, ListTokensEndpoint, RevokeTokenEndpoint)
  .middleware(BearerAuthentication);

export const BebopHttpApi = HttpApi.make("BebopHttpApi")
  .add(HealthApiGroup, BountiesApiGroup, TokensApiGroup)
  .annotateMerge(
    OpenApi.annotations({ title: "Bebop API", version: "1.0.0", description: "Bebop bounty control API" }),
  );

export const bebopOpenApi: OpenApi.OpenAPISpec = OpenApi.fromApi(BebopHttpApi);
