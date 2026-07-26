import { Schema } from "effect";

import { ConstraintLimit } from "./scalars.ts";
import { defaultConstraintValues } from "./settings.ts";

export const AttemptConstraintProfile = Schema.Struct({
  maxTurnsPerAttempt: ConstraintLimit,
  maxWallClockMinutesPerAttempt: ConstraintLimit,
});
export type AttemptConstraintProfile = typeof AttemptConstraintProfile.Type;

export const RoundConstraintProfile = Schema.Struct({
  maxRounds: ConstraintLimit,
  maxTurnsPerAttempt: ConstraintLimit,
  maxWallClockMinutesPerAttempt: ConstraintLimit,
});
export type RoundConstraintProfile = typeof RoundConstraintProfile.Type;

export const ConstraintProfile = Schema.Struct({
  primary: AttemptConstraintProfile,
  review: RoundConstraintProfile,
  qa: RoundConstraintProfile,
});
export type ConstraintProfile = typeof ConstraintProfile.Type;

export const defaultConstraintProfile = Schema.decodeUnknownSync(ConstraintProfile)(defaultConstraintValues);
