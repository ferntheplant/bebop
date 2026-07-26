import { Schema } from "effect";

import { LineNumber, ReviewFindingId } from "./scalars.ts";
import { schemaLimits } from "./settings.ts";

const Title = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.reviewTitleMaxLength), Schema.isTrimmed()),
);
const Description = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.reviewBodyMaxLength), Schema.isTrimmed()),
);
const FilePath = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.reviewFilePathMaxLength), Schema.isTrimmed()),
);

export const reviewFindingSeverities = ["blocking", "non_blocking"] as const;
export const ReviewFindingSeverity = Schema.Literals(reviewFindingSeverities);
export type ReviewFindingSeverity = typeof ReviewFindingSeverity.Type;

export const ReviewFinding = Schema.Struct({
  id: ReviewFindingId,
  severity: ReviewFindingSeverity,
  title: Title,
  description: Description,
  evidence: Description,
  file: Schema.optionalKey(FilePath),
  line: Schema.optionalKey(LineNumber),
  suggestedDirection: Schema.optionalKey(Description),
});
export type ReviewFinding = typeof ReviewFinding.Type;
