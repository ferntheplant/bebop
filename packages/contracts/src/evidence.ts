import { Schema } from "effect";

import { BountyId, ByteCount, EvidenceBundleId, GitSha, Sha256, SpecRevision, Timestamp } from "./scalars.ts";
import { schemaLimits } from "./settings.ts";
import { VerificationStage } from "./workflow.ts";

const ArtifactPath = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.evidenceArtifactPathMaxLength),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    Schema.makeFilter<string>((value) => {
      const segments = value.split("/");
      return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ? "Expected a canonical relative artifact path"
        : undefined;
    }),
  ),
  Schema.brand("EvidenceArtifactPath"),
);

const MediaType = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.evidenceMediaTypeMaxLength),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/),
  ),
  Schema.brand("MediaType"),
);

const VersionName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.evidenceToolNameMaxLength), Schema.isTrimmed()),
);
const VersionValue = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.evidenceVersionMaxLength), Schema.isTrimmed()),
);

export const evidenceArtifactKinds = [
  "validator_log",
  "ci_result",
  "review_findings",
  "qa_report",
  "screenshot",
  "browser_recording",
  "browser_console",
  "browser_network",
  "test_report",
  "other",
] as const;
export const EvidenceArtifactKind = Schema.Literals(evidenceArtifactKinds);
export type EvidenceArtifactKind = typeof EvidenceArtifactKind.Type;

export const evidenceProvenances = ["automated", "human_steered"] as const;
export const EvidenceProvenance = Schema.Literals(evidenceProvenances);
export type EvidenceProvenance = typeof EvidenceProvenance.Type;

export const VersionRecord = Schema.Struct({
  name: VersionName,
  version: VersionValue,
});
export type VersionRecord = typeof VersionRecord.Type;

export const EvidenceArtifact = Schema.Struct({
  path: ArtifactPath,
  kind: EvidenceArtifactKind,
  sha256: Sha256,
  sizeBytes: ByteCount,
  mediaType: MediaType,
});
export type EvidenceArtifact = typeof EvidenceArtifact.Type;

const EvidenceArtifacts = Schema.Array(EvidenceArtifact).pipe(
  Schema.check(
    Schema.isMinLength(schemaLimits.evidenceBundleMinArtifacts),
    Schema.makeFilter<ReadonlyArray<EvidenceArtifact>>((artifacts) => {
      const paths = new Set(artifacts.map((artifact) => artifact.path));
      if (paths.size !== artifacts.length) {
        return "Expected unique artifact paths";
      }
      const totalSize = artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
      return totalSize > schemaLimits.evidenceBundleMaxBytes
        ? `Expected at most ${schemaLimits.evidenceBundleMaxBytes} logical evidence bytes`
        : undefined;
    }),
  ),
);

export const EvidenceBundleManifest = Schema.Struct({
  bundleId: EvidenceBundleId,
  bountyId: BountyId,
  specRevision: SpecRevision,
  candidateSha: GitSha,
  stage: VerificationStage,
  provenance: EvidenceProvenance,
  createdAt: Timestamp,
  tools: Schema.Array(VersionRecord),
  environment: Schema.Array(VersionRecord),
  artifacts: EvidenceArtifacts,
});
export type EvidenceBundleManifest = typeof EvidenceBundleManifest.Type;

export function evidenceBlobObjectKey(sha256: Sha256): string {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}
