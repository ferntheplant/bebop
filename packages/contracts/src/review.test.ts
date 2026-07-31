import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { ReviewFinding } from "#src/review.ts";

const encodedFinding = {
  id: "finding-1",
  severity: "blocking",
  title: "Status can become stale",
  description: "The response does not distinguish a disconnected Swordfish.",
  evidence: "The projection returns the last stage without checking heartbeat freshness.",
  file: "apps/bebop/src/api/status.ts",
  line: 42,
  suggestedDirection: "Derive connection freshness before presenting the compact status.",
} as const;

describe("ReviewFinding", () => {
  test("decodes and re-encodes the documented shape", () => {
    const finding = Schema.decodeUnknownSync(ReviewFinding)(encodedFinding);

    expect(Schema.encodeSync(ReviewFinding)(finding)).toEqual(encodedFinding);
  });

  test("allows optional location and suggested direction fields to be absent", () => {
    const finding = Schema.decodeUnknownSync(ReviewFinding)({
      id: "finding-2",
      severity: "non_blocking",
      title: "Improve naming",
      description: "The field name could be clearer.",
      evidence: "The current name omits its unit.",
    });

    expect(finding.file).toBeUndefined();
    expect(finding.line).toBeUndefined();
  });

  test("rejects unsupported severities and invalid line numbers", () => {
    expect(() => Schema.decodeUnknownSync(ReviewFinding)({ ...encodedFinding, severity: "warning" })).toThrow();
    expect(() => Schema.decodeUnknownSync(ReviewFinding)({ ...encodedFinding, line: 0 })).toThrow();
  });
});
