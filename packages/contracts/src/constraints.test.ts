import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  attemptAllowance,
  attemptWatchdogs,
  ConstraintProfile,
  constraintScopeForRole,
  defaultConstraintProfile,
  scopeForRerunTarget,
} from "#src/constraints.ts";
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
        building: { ...defaultConstraintValues.building, turnsPerAttempt: 0 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ConstraintProfile)({
        ...defaultConstraintValues,
        qa: { ...defaultConstraintValues.qa, attemptsPerCandidate: 1.5 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ConstraintProfile)({ ...defaultConstraintValues, validatedCandidatesPerSpec: 0 }),
    ).toThrow();
  });

  test("reads each scope's allowance through the field name that scope actually uses", () => {
    // Building counts per build cycle and the other two count per candidate, so the two field names differ and
    // this function is the only thing that may know it.
    expect(attemptAllowance(defaultConstraintProfile, "building")).toBe(3);
    expect(attemptAllowance(defaultConstraintProfile, "review")).toBe(2);
    expect(attemptAllowance(defaultConstraintProfile, "qa")).toBe(2);
  });

  test("gives every scope a turn and a wall-clock watchdog", () => {
    expect(attemptWatchdogs(defaultConstraintProfile, "building")).toEqual({ turns: 40, wallClockMinutes: 90 });
    expect(attemptWatchdogs(defaultConstraintProfile, "review")).toEqual({ turns: 15, wallClockMinutes: 30 });
    expect(attemptWatchdogs(defaultConstraintProfile, "qa")).toEqual({ turns: 20, wallClockMinutes: 45 });
  });
});

describe("constraint scopes", () => {
  test("derives a scope from the cowboy driving it", () => {
    expect(constraintScopeForRole).toEqual({ ein: "building", jet: "review", faye: "qa" });
  });

  test("grants no attempt for a validation rerun", () => {
    // `rerun validation` repeats a deterministic operation on the same SHA and is not a cowboy attempt at all,
    // which is why it has a target but no scope.
    expect(scopeForRerunTarget("validation")).toBeNull();
    expect(scopeForRerunTarget("building")).toBe("building");
    expect(scopeForRerunTarget("review")).toBe("review");
    expect(scopeForRerunTarget("qa")).toBe("qa");
  });
});
