import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { FeedbackPacket, GateFeedback, isFeedbackForGate, ValidatorRun } from "#src/feedback.ts";
import { GateCompletedEvent } from "#src/protocol.ts";

const timestamp = "2026-07-26T12:34:56.000Z";
const candidateSha = "b".repeat(40);

const validatorRun = {
  command: "vp run ready",
  environmentProfile: "clean-room",
  startedAt: timestamp,
  endedAt: "2026-07-26T12:36:00.000Z",
  outcome: { kind: "exited", code: 1 },
  capturedOutput: "3 tests failed",
  artifactPaths: ["reports/junit.xml"],
} as const;

const gateEvent = (overrides: Record<string, unknown>) => ({
  type: "gate_completed",
  gate: "local_validation",
  candidateSha,
  specRevision: 1,
  outcome: "passed",
  ...overrides,
});

describe("stage feedback", () => {
  test("round-trips a validator run including how the process ended", () => {
    const decoded = Schema.decodeUnknownSync(ValidatorRun)(validatorRun);
    expect(Schema.encodeSync(ValidatorRun)(decoded)).toEqual(validatorRun);

    // A timeout is its own outcome rather than an exit code, because a hook timing out has to
    // kill the process group and consume an attempt budget for it.
    const timedOut = { ...validatorRun, outcome: { kind: "timed_out", afterMilliseconds: 600_000 } } as const;
    expect(Schema.encodeSync(ValidatorRun)(Schema.decodeUnknownSync(ValidatorRun)(timedOut))).toEqual(timedOut);
  });

  test("a failed gate must carry feedback", () => {
    expect(() => Schema.decodeUnknownSync(GateCompletedEvent)(gateEvent({ outcome: "failed" }))).toThrow();

    const explained = gateEvent({
      outcome: "failed",
      feedback: { kind: "validator", runs: [validatorRun] },
    });
    expect(Schema.decodeUnknownSync(GateCompletedEvent)(explained).outcome).toBe("failed");
  });

  test("a stage that produced nothing usable says so, and is not an empty result", () => {
    // The distinction the whole module exists for: jet answering with prose is a value the
    // system can see, and it is not the same as jet finding nothing wrong.
    const unusable = gateEvent({
      gate: "code_review",
      outcome: "failed",
      feedback: {
        kind: "unstructured",
        reason: "agent_output_failed_schema_validation",
        detail: "the seat replied with prose instead of findings",
      },
    });
    const decoded = Schema.decodeUnknownSync(GateCompletedEvent)(unusable);
    expect(decoded.feedback?.kind).toBe("unstructured");

    const cleanReview = gateEvent({
      gate: "code_review",
      outcome: "passed",
      feedback: { kind: "review", findings: [] },
    });
    expect(Schema.decodeUnknownSync(GateCompletedEvent)(cleanReview).feedback?.kind).toBe("review");
  });

  test("feedback must match the gate that produced it", () => {
    expect(() =>
      Schema.decodeUnknownSync(GateCompletedEvent)(
        gateEvent({ gate: "qa", outcome: "failed", feedback: { kind: "validator", runs: [validatorRun] } }),
      ),
    ).toThrow();

    // `unstructured` is accepted on every gate, including `evidence_upload`, which has no
    // agent output of its own.
    expect(
      isFeedbackForGate("evidence_upload", {
        kind: "unstructured",
        reason: "stage_infrastructure_failure",
        detail: "",
      }),
    ).toBe(true);
    expect(isFeedbackForGate("evidence_upload", { kind: "review", findings: [] })).toBe(false);
    expect(isFeedbackForGate("code_review", { kind: "review", findings: [] })).toBe(true);
  });

  test("a passed gate may still carry non-blocking findings", () => {
    const withFindings = gateEvent({
      gate: "code_review",
      outcome: "passed",
      feedback: {
        kind: "review",
        findings: [
          {
            id: "rf-1",
            severity: "non_blocking",
            title: "Prefer a named constant",
            description: "The retry budget is a literal.",
            evidence: "src/worker.ts:42",
          },
        ],
      },
    });
    const decoded = Schema.decodeUnknownSync(GateCompletedEvent)(withFindings);
    expect(decoded.outcome).toBe("passed");
  });

  test("an aggregated packet rejects feedback that does not belong to its gate", () => {
    const packet = {
      candidateSha,
      specRevision: 1,
      assembledAt: timestamp,
      entries: [{ gate: "local_validation", outcome: "failed", feedback: { kind: "validator", runs: [validatorRun] } }],
    } as const;
    expect(Schema.encodeSync(FeedbackPacket)(Schema.decodeUnknownSync(FeedbackPacket)(packet))).toEqual(packet);

    expect(() =>
      Schema.decodeUnknownSync(FeedbackPacket)({
        ...packet,
        entries: [{ gate: "qa", outcome: "failed", feedback: { kind: "validator", runs: [validatorRun] } }],
      }),
    ).toThrow();

    // Ein cannot revise against nothing.
    expect(() => Schema.decodeUnknownSync(FeedbackPacket)({ ...packet, entries: [] })).toThrow();
  });

  test("every feedback kind decodes from its wire form", () => {
    const kinds = [
      { kind: "validator", runs: [validatorRun] },
      { kind: "external_ci", checks: [{ name: "build", outcome: "failed" }] },
      { kind: "review", findings: [] },
      {
        kind: "qa",
        scenarios: [
          {
            id: "qa-1",
            description: "Sign in",
            expectedOutcome: "The dashboard renders",
            observedOutcome: "A 500 page renders",
            result: "failed",
            artifactPaths: ["screenshots/signin.png"],
          },
        ],
      },
      { kind: "unstructured", reason: "agent_produced_no_output", detail: "" },
    ] as const;

    for (const kind of kinds) {
      expect(Schema.encodeSync(GateFeedback)(Schema.decodeUnknownSync(GateFeedback)(kind))).toEqual(kind);
    }
  });
});
