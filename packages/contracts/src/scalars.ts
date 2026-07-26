import { Schema } from "effect";

import { schemaLimits } from "./settings.ts";

const SafeIdentifier = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.opaqueIdentifierMaxLength),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
);

export const BountyId = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.bountyIdMaxLength),
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  ),
  Schema.brand("BountyId"),
);
export type BountyId = typeof BountyId.Type;

export const VmId = SafeIdentifier.pipe(Schema.brand("VmId"));
export type VmId = typeof VmId.Type;

export const SeatId = SafeIdentifier.pipe(Schema.brand("SeatId"));
export type SeatId = typeof SeatId.Type;

export const CommandId = SafeIdentifier.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;

export const AcceptanceCriterionId = SafeIdentifier.pipe(Schema.brand("AcceptanceCriterionId"));
export type AcceptanceCriterionId = typeof AcceptanceCriterionId.Type;

export const ReviewFindingId = SafeIdentifier.pipe(Schema.brand("ReviewFindingId"));
export type ReviewFindingId = typeof ReviewFindingId.Type;

export const EvidenceBundleId = SafeIdentifier.pipe(Schema.brand("EvidenceBundleId"));
export type EvidenceBundleId = typeof EvidenceBundleId.Type;

export const GitSha = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
  Schema.brand("GitSha"),
);
export type GitSha = typeof GitSha.Type;

export const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)), Schema.brand("Sha256"));
export type Sha256 = typeof Sha256.Type;

const CanonicalUtcTimestampString = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    Schema.makeFilter<string>((value) => {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value
        ? "Expected a canonical UTC timestamp"
        : undefined;
    }),
  ),
);

export const Timestamp = CanonicalUtcTimestampString.pipe(
  Schema.decodeTo(Schema.DateTimeUtcFromString),
  Schema.brand("Timestamp"),
);
export type Timestamp = typeof Timestamp.Type;

export const EventSequence = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  Schema.brand("EventSequence"),
);
export type EventSequence = typeof EventSequence.Type;

export const ByteCount = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  Schema.brand("ByteCount"),
);
export type ByteCount = typeof ByteCount.Type;

const PositiveSafeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
);

export const SpecRevision = PositiveSafeInteger.pipe(Schema.brand("SpecRevision"));
export type SpecRevision = typeof SpecRevision.Type;

export const Port = PositiveSafeInteger.pipe(Schema.check(Schema.isLessThanOrEqualTo(65_535)), Schema.brand("Port"));
export type Port = typeof Port.Type;

export const LineNumber = PositiveSafeInteger.pipe(Schema.brand("LineNumber"));
export type LineNumber = typeof LineNumber.Type;

export const ConstraintLimit = PositiveSafeInteger.pipe(Schema.brand("ConstraintLimit"));
export type ConstraintLimit = typeof ConstraintLimit.Type;

export const currentProtocolVersion = 1 as const;
export const ProtocolVersion = Schema.Literal(currentProtocolVersion);
export type ProtocolVersion = typeof ProtocolVersion.Type;
