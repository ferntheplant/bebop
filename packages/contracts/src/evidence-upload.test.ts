import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  EvidenceUploadCommittedMessage,
  EvidenceUploadFinalizeMessage,
  EvidenceUploadOfferMessage,
  EvidenceUploadRejectedMessage,
  EvidenceUploadRequiredMessage,
} from "#src/evidence-upload.ts";
import { BebopToSwordfishMessage, SwordfishToBebopMessage } from "#src/protocol.ts";

const artifactHash = "a".repeat(64);
const identity = {
  protocolVersion: 1,
  bountyId: "bty-01jz8j3d9f4x",
  vmId: "vm_01JZ8J3D9F4X",
} as const;
const bundleId = "evidence-01jz8j3d9f4x";
const timestamp = "2026-07-26T12:34:56.000Z";
const manifest = {
  bundleId,
  bountyId: identity.bountyId,
  specRevision: 1,
  candidateSha: "b".repeat(40),
  stage: "local_validation",
  provenance: "automated",
  createdAt: timestamp,
  tools: [{ name: "bun", version: "1.3.14" }],
  environment: [{ name: "linux", version: "6.8.0" }],
  artifacts: [
    {
      path: "validation/stdout.log",
      kind: "validator_log",
      sha256: artifactHash,
      sizeBytes: 1_024,
      mediaType: "text/plain",
    },
    {
      path: "validation/combined.log",
      kind: "validator_log",
      sha256: artifactHash,
      sizeBytes: 1_024,
      mediaType: "text/plain",
    },
  ],
} as const;

describe("evidence upload negotiation", () => {
  test("round-trips a stable manifest offer from Swordfish", () => {
    const encoded = { ...identity, type: "evidence_upload_offer", manifest } as const;
    const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);

    expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
    expect(Schema.decodeUnknownSync(EvidenceUploadOfferMessage)(encoded)).toEqual(decoded);
  });

  test("rejects an offer whose outer and manifest bounty identities differ", () => {
    expect(() =>
      Schema.decodeUnknownSync(EvidenceUploadOfferMessage)({
        ...identity,
        type: "evidence_upload_offer",
        manifest: { ...manifest, bountyId: "bty-other" },
      }),
    ).toThrow();
  });

  test("round-trips unique upload targets for missing blobs", () => {
    const encoded = {
      ...identity,
      type: "evidence_upload_required",
      bundleId,
      blobs: [
        {
          sha256: artifactHash,
          sizeBytes: 1_024,
          uploadUrl: `https://bebop.example.private/evidence/blobs/${artifactHash}`,
          expiresAt: timestamp,
        },
      ],
    } as const;
    const decoded = Schema.decodeUnknownSync(BebopToSwordfishMessage)(encoded);

    expect(Schema.encodeSync(BebopToSwordfishMessage)(decoded)).toEqual(encoded);
    expect(Schema.decodeUnknownSync(EvidenceUploadRequiredMessage)(encoded)).toEqual(decoded);
    expect(() =>
      Schema.decodeUnknownSync(EvidenceUploadRequiredMessage)({
        ...encoded,
        blobs: [encoded.blobs[0], encoded.blobs[0]],
      }),
    ).toThrow();
  });

  test("finalizes a pending manifest through its durable bundle ID", () => {
    const encoded = {
      ...identity,
      type: "evidence_upload_finalize",
      bundleId,
    } as const;
    const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);

    expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
    expect(Schema.decodeUnknownSync(EvidenceUploadFinalizeMessage)(encoded)).toEqual(decoded);
  });

  test("round-trips the durable commit result", () => {
    const encoded = {
      ...identity,
      type: "evidence_upload_committed",
      bundleId,
      committedAt: timestamp,
    } as const;
    const decoded = Schema.decodeUnknownSync(EvidenceUploadCommittedMessage)(encoded);

    expect(Schema.encodeSync(BebopToSwordfishMessage)(decoded)).toEqual(encoded);
  });

  test("round-trips stable evidence rejection codes", () => {
    const encoded = {
      ...identity,
      type: "evidence_upload_rejected",
      bundleId,
      code: "bundle_conflict",
      message: "The bundle ID was previously offered with a different manifest.",
    } as const;
    const decoded = Schema.decodeUnknownSync(EvidenceUploadRejectedMessage)(encoded);

    expect(Schema.encodeSync(BebopToSwordfishMessage)(decoded)).toEqual(encoded);
  });
});
