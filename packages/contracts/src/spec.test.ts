import { DateTime, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { EffectiveSpec } from "#src/spec.ts";

const encodedSpec = {
  revision: 1,
  title: "Add bounty status",
  goal: "Expose the current bounty status through the API.",
  context: ["The CLI consumes the generated API client."],
  constraints: ["Keep the API private."],
  nonGoals: ["Do not add a web dashboard."],
  acceptanceCriteria: [
    {
      id: "status-response",
      description: "The API returns the current compact and detailed status.",
    },
  ],
  suggestedQaScenarios: [
    {
      description: "Request a connected bounty.",
      expectedOutcome: "The response reports a fresh Swordfish connection.",
    },
  ],
  createdFromSeatId: "ses_01JZ8J3D9F4X",
  createdAt: "2026-07-26T12:34:56.000Z",
} as const;

describe("EffectiveSpec", () => {
  test("decodes and re-encodes the SPEC shape", () => {
    const spec = Schema.decodeUnknownSync(EffectiveSpec)(encodedSpec);

    expect(DateTime.isUtc(spec.createdAt)).toBe(true);
    expect(Schema.encodeSync(EffectiveSpec)(spec)).toEqual(encodedSpec);
  });

  test("requires revisions to start at one", () => {
    expect(() => Schema.decodeUnknownSync(EffectiveSpec)({ ...encodedSpec, revision: 0 })).toThrow();
  });

  test("requires at least one acceptance criterion", () => {
    expect(() => Schema.decodeUnknownSync(EffectiveSpec)({ ...encodedSpec, acceptanceCriteria: [] })).toThrow();
  });

  test("rejects untrimmed descriptive text", () => {
    expect(() => Schema.decodeUnknownSync(EffectiveSpec)({ ...encodedSpec, title: " Add bounty status" })).toThrow();
  });
});
