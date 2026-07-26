import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { Candidate } from "#src/candidate.ts";

const encodedCandidate = {
  commitSha: "a".repeat(40),
  specRevision: 1,
  summary: "Add the bounty status endpoint and CLI output.",
  claimedLocalChecks: [
    {
      command: "vp test --run",
      result: "passed",
      details: "All contract tests passed.",
    },
  ],
  activeDevelopmentServers: [
    {
      name: "api",
      port: 3000,
      url: "http://127.0.0.1:3000/",
    },
  ],
  knownLimitations: [],
  disposition: "candidate_ready",
} as const;

describe("Candidate", () => {
  test("decodes and re-encodes candidate metadata", () => {
    const candidate = Schema.decodeUnknownSync(Candidate)(encodedCandidate);

    expect(candidate.activeDevelopmentServers[0]?.url).toBeInstanceOf(URL);
    expect(Schema.encodeSync(Candidate)(candidate)).toEqual(encodedCandidate);
  });

  test("permits candidates without checks or active development servers", () => {
    const candidate = Schema.decodeUnknownSync(Candidate)({
      ...encodedCandidate,
      claimedLocalChecks: [],
      activeDevelopmentServers: [],
      knownLimitations: ["Browser QA is not applicable."],
    });

    expect(candidate.claimedLocalChecks).toEqual([]);
  });

  test("rejects invalid ports and check results", () => {
    expect(() =>
      Schema.decodeUnknownSync(Candidate)({
        ...encodedCandidate,
        activeDevelopmentServers: [{ name: "api", port: 65_536 }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Candidate)({
        ...encodedCandidate,
        claimedLocalChecks: [{ command: "vp test --run", result: "unknown" }],
      }),
    ).toThrow();
  });

  test("rejects abbreviated commit shas", () => {
    expect(() => Schema.decodeUnknownSync(Candidate)({ ...encodedCandidate, commitSha: "abc123" })).toThrow();
  });
});
