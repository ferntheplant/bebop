import { DateTime, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { EvidenceBundleManifest, evidenceBlobObjectKey } from "#src/evidence.ts";
import { Sha256 } from "#src/scalars.ts";
import { schemaLimits } from "#src/settings.ts";

const artifactHash = "a".repeat(64);
const encodedManifest = {
  bundleId: "evidence-01jz8j3d9f4x",
  bountyId: "bty-01jz8j3d9f4x",
  specRevision: 1,
  candidateSha: "b".repeat(40),
  stage: "local_validation",
  provenance: "automated",
  createdAt: "2026-07-26T12:34:56.000Z",
  tools: [
    { name: "vite-plus", version: "0.2.6" },
    { name: "bun", version: "1.3.14" },
  ],
  environment: [{ name: "linux", version: "6.8.0" }],
  artifacts: [
    {
      path: "validation/stdout.log",
      kind: "validator_log",
      sha256: artifactHash,
      sizeBytes: 1_024,
      mediaType: "text/plain",
    },
  ],
} as const;

describe("EvidenceBundleManifest", () => {
  test("decodes and re-encodes commit-bound evidence metadata", () => {
    const manifest = Schema.decodeUnknownSync(EvidenceBundleManifest)(encodedManifest);

    expect(DateTime.isUtc(manifest.createdAt)).toBe(true);
    expect(Schema.encodeSync(EvidenceBundleManifest)(manifest)).toEqual(encodedManifest);
  });

  test("allows the same content blob at distinct logical paths", () => {
    const manifest = Schema.decodeUnknownSync(EvidenceBundleManifest)({
      ...encodedManifest,
      artifacts: [
        encodedManifest.artifacts[0],
        {
          ...encodedManifest.artifacts[0],
          path: "validation/combined.log",
        },
      ],
    });

    expect(manifest.artifacts).toHaveLength(2);
  });

  test("requires at least one artifact with a unique canonical path", () => {
    expect(() => Schema.decodeUnknownSync(EvidenceBundleManifest)({ ...encodedManifest, artifacts: [] })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EvidenceBundleManifest)({
        ...encodedManifest,
        artifacts: [encodedManifest.artifacts[0], encodedManifest.artifacts[0]],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EvidenceBundleManifest)({
        ...encodedManifest,
        artifacts: [{ ...encodedManifest.artifacts[0], path: "../secrets.txt" }],
      }),
    ).toThrow();
  });

  test("enforces the logical bundle size cap before deduplication", () => {
    expect(() =>
      Schema.decodeUnknownSync(EvidenceBundleManifest)({
        ...encodedManifest,
        artifacts: [
          { ...encodedManifest.artifacts[0], sizeBytes: schemaLimits.evidenceBundleMaxBytes },
          { ...encodedManifest.artifacts[0], path: "validation/stderr.log", sizeBytes: 1 },
        ],
      }),
    ).toThrow();
  });

  test("rejects invalid hashes, media types, provenance, and producer stages", () => {
    expect(() =>
      Schema.decodeUnknownSync(EvidenceBundleManifest)({
        ...encodedManifest,
        artifacts: [{ ...encodedManifest.artifacts[0], sha256: "A".repeat(64) }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EvidenceBundleManifest)({
        ...encodedManifest,
        artifacts: [{ ...encodedManifest.artifacts[0], mediaType: "plain-text" }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EvidenceBundleManifest)({ ...encodedManifest, provenance: "manual" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EvidenceBundleManifest)({ ...encodedManifest, stage: "evidence_upload" }),
    ).toThrow();
  });
});

test("derives the canonical object-store key from a verified hash", () => {
  const sha256 = Schema.decodeUnknownSync(Sha256)(artifactHash);

  expect(evidenceBlobObjectKey(sha256)).toBe(`blobs/sha256/aa/${artifactHash}`);
});
