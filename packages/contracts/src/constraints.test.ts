import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { ConstraintProfile, defaultConstraintProfile } from "#src/constraints.ts";
import { defaultConstraintValues } from "#src/settings.ts";

describe("ConstraintProfile", () => {
  test("matches and round-trips the documented defaults", () => {
    expect(Schema.encodeSync(ConstraintProfile)(defaultConstraintProfile)).toEqual(defaultConstraintValues);
    expect(
      Schema.encodeSync(ConstraintProfile)(Schema.decodeUnknownSync(ConstraintProfile)(defaultConstraintValues)),
    ).toEqual(defaultConstraintValues);
  });

  test("requires every limit to be a positive integer", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConstraintProfile)({
        ...defaultConstraintValues,
        primary: { ...defaultConstraintValues.primary, maxTurnsPerAttempt: 0 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ConstraintProfile)({
        ...defaultConstraintValues,
        qa: { ...defaultConstraintValues.qa, maxRounds: 1.5 },
      }),
    ).toThrow();
  });
});
