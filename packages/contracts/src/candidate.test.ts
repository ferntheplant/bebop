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

    expect(candidate.activeDevelopmentServers[0]?.url).toBe("http://127.0.0.1:3000/");
    expect(Schema.encodeSync(Candidate)(candidate)).toEqual(encodedCandidate);
  });

  test("holds development server urls to the same canonicalization as every other url", () => {
    const withUrl = (url: string) => ({
      ...encodedCandidate,
      activeDevelopmentServers: [{ name: "api", port: 3000, url }],
    });

    // `http://127.0.0.1:3000` normalises to a trailing slash, so the non-canonical
    // spelling must not be storable alongside the canonical one.
    expect(() => Schema.decodeUnknownSync(Candidate)(withUrl("http://127.0.0.1:3000"))).toThrow();
    expect(() => Schema.decodeUnknownSync(Candidate)(withUrl("http://user:pw@127.0.0.1:3000/"))).toThrow();
    expect(() => Schema.decodeUnknownSync(Candidate)(withUrl("http://127.0.0.1:3000/#top"))).toThrow();
    expect(() => Schema.decodeUnknownSync(Candidate)(withUrl("ftp://127.0.0.1:3000/"))).toThrow();
    expect(() => Schema.decodeUnknownSync(Candidate)(withUrl("not a url"))).toThrow();

    // Plain HTTP is the normal case for a server running inside the bounty VM.
    const decoded = Schema.decodeUnknownSync(Candidate)(withUrl("https://api.vm.internal/"));
    expect(decoded.activeDevelopmentServers[0]?.url).toBe("https://api.vm.internal/");
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
