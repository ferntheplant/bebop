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

export const CorrelationId = SafeIdentifier.pipe(Schema.brand("CorrelationId"));
export type CorrelationId = typeof CorrelationId.Type;

export const ApiRequestId = SafeIdentifier.pipe(Schema.brand("ApiRequestId"));
export type ApiRequestId = typeof ApiRequestId.Type;

export const IdempotencyKey = SafeIdentifier.pipe(Schema.brand("IdempotencyKey"));
export type IdempotencyKey = typeof IdempotencyKey.Type;

export const AcceptanceCriterionId = SafeIdentifier.pipe(Schema.brand("AcceptanceCriterionId"));
export type AcceptanceCriterionId = typeof AcceptanceCriterionId.Type;

export const ReviewFindingId = SafeIdentifier.pipe(Schema.brand("ReviewFindingId"));
export type ReviewFindingId = typeof ReviewFindingId.Type;

export const EvidenceBundleId = SafeIdentifier.pipe(Schema.brand("EvidenceBundleId"));
export type EvidenceBundleId = typeof EvidenceBundleId.Type;

export const ConnectionId = SafeIdentifier.pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;

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

export const WorkflowRevision = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  Schema.brand("WorkflowRevision"),
);
export type WorkflowRevision = typeof WorkflowRevision.Type;

export const BountyEventCursor = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  Schema.brand("BountyEventCursor"),
);
export type BountyEventCursor = typeof BountyEventCursor.Type;

export const BountyEventCursorString = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(?:0|[1-9][0-9]*)$/),
    Schema.makeFilter<string>((value) =>
      Number.isSafeInteger(Number(value)) ? undefined : "Expected a safe bounty event cursor",
    ),
  ),
  Schema.brand("BountyEventCursorString"),
);
export type BountyEventCursorString = typeof BountyEventCursorString.Type;

export const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
);

export const ProducedEventSequence = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  Schema.brand("ProducedEventSequence"),
);
export type ProducedEventSequence = typeof ProducedEventSequence.Type;

/**
 * Widens a produced sequence (at least 1) into an applied cursor (at least 0).
 *
 * Every produced sequence is a valid cursor, so this cannot fail. It exists as a named
 * function because the alternative at each call site was `value as number as EventSequence`,
 * a double cast that defeats both brands and is invisible to a search for unsafe casts.
 */
export function toEventSequence(sequence: ProducedEventSequence): EventSequence {
  return sequence as number as EventSequence;
}

export const ByteCount = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  Schema.brand("ByteCount"),
);
export type ByteCount = typeof ByteCount.Type;

export const PositiveByteCount = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  Schema.brand("PositiveByteCount"),
);
export type PositiveByteCount = typeof PositiveByteCount.Type;

const PositiveSafeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
);

export const SpecRevision = PositiveSafeInteger.pipe(Schema.brand("SpecRevision"));
export type SpecRevision = typeof SpecRevision.Type;

export const Port = PositiveSafeInteger.pipe(Schema.check(Schema.isLessThanOrEqualTo(65_535)), Schema.brand("Port"));
export type Port = typeof Port.Type;

export const HttpsUrl = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.httpsUrlMaxLength),
    Schema.isTrimmed(),
    Schema.makeFilter<string>((value) => {
      try {
        const url = Schema.decodeUnknownSync(Schema.URLFromString)(value);
        if (url.protocol !== "https:") {
          return "Expected an HTTPS URL";
        }
        if (url.username.length > 0 || url.password.length > 0) {
          return "Expected an HTTPS URL without embedded credentials";
        }
        if (url.hash.length > 0) {
          return "Expected an HTTPS URL without a fragment";
        }
        return Schema.encodeSync(Schema.URLFromString)(url) === value ? undefined : "Expected a canonical HTTPS URL";
      } catch {
        return "Expected a valid HTTPS URL";
      }
    }),
  ),
  Schema.brand("HttpsUrl"),
);
export type HttpsUrl = typeof HttpsUrl.Type;

export const LineNumber = PositiveSafeInteger.pipe(Schema.brand("LineNumber"));
export type LineNumber = typeof LineNumber.Type;

export const ConstraintLimit = PositiveSafeInteger.pipe(Schema.brand("ConstraintLimit"));
export type ConstraintLimit = typeof ConstraintLimit.Type;

export const RepositorySlug = Schema.String.pipe(
  Schema.check(Schema.isMinLength(3), Schema.isMaxLength(200), Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  Schema.brand("RepositorySlug"),
);
export type RepositorySlug = typeof RepositorySlug.Type;

export const GitRef = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    Schema.makeFilter<string>((value) => {
      const segments = value.split("/");
      return value.includes("..") ||
        value.includes("//") ||
        value.endsWith(".") ||
        value.endsWith("/") ||
        value.endsWith(".lock") ||
        segments.some((segment) => segment.startsWith("."))
        ? "Expected a canonical Git ref"
        : undefined;
    }),
  ),
  Schema.brand("GitRef"),
);
export type GitRef = typeof GitRef.Type;

export const currentProtocolVersion = 1 as const;
export const ProtocolVersion = Schema.Literal(currentProtocolVersion);
export type ProtocolVersion = typeof ProtocolVersion.Type;
