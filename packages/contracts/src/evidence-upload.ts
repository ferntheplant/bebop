import { Schema } from "effect";

import { EvidenceBlobDescriptor, EvidenceBundleManifest } from "./evidence.ts";
import type { Sha256 } from "./scalars.ts";
import { BountyId, EvidenceBundleId, HttpsUrl, ProtocolVersion, Timestamp, VmId } from "./scalars.ts";
import { schemaLimits } from "./settings.ts";

const EvidenceUploadIdentity = {
  protocolVersion: ProtocolVersion,
  bountyId: BountyId,
  vmId: VmId,
} as const;
const EvidenceUploadRejectionMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.protocolMessageMaxLength), Schema.isTrimmed()),
);

const EvidenceUploadOfferMessageBase = Schema.Struct({
  type: Schema.Literal("evidence_upload_offer"),
  ...EvidenceUploadIdentity,
  manifest: EvidenceBundleManifest,
});
export const EvidenceUploadOfferMessage = EvidenceUploadOfferMessageBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof EvidenceUploadOfferMessageBase.Type>((message) =>
      message.bountyId === message.manifest.bountyId
        ? undefined
        : "Expected the evidence manifest bounty to match the message bounty",
    ),
  ),
);
export type EvidenceUploadOfferMessage = typeof EvidenceUploadOfferMessage.Type;

// The bundle ID is the durable idempotency key for finalize and reconnect replay.
export const EvidenceUploadFinalizeMessage = Schema.Struct({
  type: Schema.Literal("evidence_upload_finalize"),
  ...EvidenceUploadIdentity,
  bundleId: EvidenceBundleId,
});
export type EvidenceUploadFinalizeMessage = typeof EvidenceUploadFinalizeMessage.Type;

export const EvidenceBlobUploadTarget = Schema.Struct({
  ...EvidenceBlobDescriptor.fields,
  uploadUrl: HttpsUrl,
  expiresAt: Timestamp,
});
export type EvidenceBlobUploadTarget = typeof EvidenceBlobUploadTarget.Type;

const EvidenceBlobUploadTargets = Schema.Array(EvidenceBlobUploadTarget).pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.makeFilter<ReadonlyArray<EvidenceBlobUploadTarget>>((targets) => {
      const hashes = new Set<Sha256>(targets.map((target) => target.sha256));
      return hashes.size === targets.length ? undefined : "Expected unique evidence upload target hashes";
    }),
  ),
);

export const EvidenceUploadRequiredMessage = Schema.Struct({
  type: Schema.Literal("evidence_upload_required"),
  ...EvidenceUploadIdentity,
  bundleId: EvidenceBundleId,
  blobs: EvidenceBlobUploadTargets,
});
export type EvidenceUploadRequiredMessage = typeof EvidenceUploadRequiredMessage.Type;

export const EvidenceUploadCommittedMessage = Schema.Struct({
  type: Schema.Literal("evidence_upload_committed"),
  ...EvidenceUploadIdentity,
  bundleId: EvidenceBundleId,
  committedAt: Timestamp,
});
export type EvidenceUploadCommittedMessage = typeof EvidenceUploadCommittedMessage.Type;

export const evidenceUploadRejectionCodes = [
  "bundle_not_found",
  "bundle_conflict",
  "blob_size_conflict",
  "blob_verification_failed",
] as const;
export const EvidenceUploadRejectionCode = Schema.Literals(evidenceUploadRejectionCodes);
export type EvidenceUploadRejectionCode = typeof EvidenceUploadRejectionCode.Type;

export const EvidenceUploadRejectedMessage = Schema.Struct({
  type: Schema.Literal("evidence_upload_rejected"),
  ...EvidenceUploadIdentity,
  bundleId: EvidenceBundleId,
  code: EvidenceUploadRejectionCode,
  message: EvidenceUploadRejectionMessage,
});
export type EvidenceUploadRejectedMessage = typeof EvidenceUploadRejectedMessage.Type;
