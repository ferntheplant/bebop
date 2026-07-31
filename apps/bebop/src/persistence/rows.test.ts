// Reading values back out of Postgres, in the forms the driver actually produces.
//
// `prototypes/persistence` established two of these behaviours against a real database (PG5:
// `bigint` arrives as a string; PG4b: `jsonb` reorders keys). These tests pin the decoding
// side of that so a schema written as `Schema.Number` against a sequence column fails here
// rather than in production when the first real sequence number appears.

import { describe, expect, test } from "vite-plus/test";

import { timestampToIso } from "#src/domain/identity.ts";
import {
  bigintNumber,
  jsonbParameter,
  oneOf,
  optionalText,
  RowDecodeError,
  text,
  timestamp,
} from "#src/persistence/rows.ts";

describe("row decoding", () => {
  test("accepts a bigint in the string form the driver returns", () => {
    expect(bigintNumber({ sequence: "42" }, "sequence")).toBe(42);
  });

  test("accepts an integer column in its number form", () => {
    expect(bigintNumber({ attempts: 3 }, "attempts")).toBe(3);
  });

  test("refuses a bigint too large to be a safe JavaScript integer", () => {
    // 2^53 + 1, the value `prototypes/persistence` PG5 stored. Rounding it silently would corrupt
    // an acknowledgement cursor in a way nothing downstream could detect.
    expect(() => bigintNumber({ sequence: "9007199254740993" }, "sequence")).toThrow(RowDecodeError);
  });

  test("refuses a bigint that is not an integer at all", () => {
    expect(() => bigintNumber({ sequence: "12.5" }, "sequence")).toThrow(RowDecodeError);
    expect(() => bigintNumber({ sequence: null }, "sequence")).toThrow(RowDecodeError);
  });

  test("decodes a timestamp from the Date the driver returns", () => {
    const decoded = timestamp({ created_at: new Date("2026-07-29T12:34:56.000Z") }, "created_at");
    expect(timestampToIso(decoded)).toBe("2026-07-29T12:34:56.000Z");
  });

  test("distinguishes an absent column from an empty one", () => {
    expect(optionalText({ reason: null }, "reason")).toBeUndefined();
    expect(optionalText({ reason: "" }, "reason")).toBe("");
    expect(() => text({ reason: null }, "reason")).toThrow(RowDecodeError);
  });

  test("refuses a value outside the set a column is allowed to hold", () => {
    expect(oneOf({ kind: "provision" }, "kind", ["provision", "destroy"])).toBe("provision");
    expect(() => oneOf({ kind: "teleport" }, "kind", ["provision", "destroy"])).toThrow(RowDecodeError);
  });

  test("encodes an array for a jsonb column as JSON, not as a Postgres array", () => {
    // The driver's own `sql.json` helper encodes a JavaScript array as a Postgres array
    // literal, which Postgres rejects for a `jsonb` column. Objects survive it, which is what
    // makes the bug easy to miss.
    expect(jsonbParameter(["context7", "sentry"])).toBe('["context7","sentry"]');
    expect(jsonbParameter({ nested: [1, 2] })).toBe('{"nested":[1,2]}');
    expect(jsonbParameter(undefined)).toBe("null");
  });
});
