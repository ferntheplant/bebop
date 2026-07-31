// Structured outputs of the stages the workflow gates on — local validation, code review,
// and QA, in `docs/capabilities/08-local-validation.md`, `09-code-review.md`, and `10-qa.md` —
// plus the aggregated packet ein consumes in order to revise.
//
// These ride the protocol rather than the evidence bundle. A gate outcome is `passed` or
// `failed`; without this module the *why* had nowhere to live except unstructured blobs,
// and the gate and harness work would have grown app-local types in Swordfish — exactly the
// drift the shared contracts exist to prevent.
//
// The design decision that shapes everything here: an agent that cannot produce structured
// feedback is a **detectable error**, not a silent absence. `UnstructuredFeedback` is a
// member of the feedback union with a reason, so "jet returned prose instead of findings"
// is a value the reducer, the API, and the operator can all see — and is distinguishable
// from "jet reviewed the candidate and found nothing".

import { Schema } from "effect";

import { EvidenceArtifactPath } from "./evidence.ts";
import { ReviewFinding } from "./review.ts";
import { GitSha, QaScenarioId, SpecRevision, Timestamp } from "./scalars.ts";
import { schemaLimits } from "./settings.ts";
import { CandidateGate, GateOutcome } from "./workflow.ts";

const Command = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.feedbackCommandMaxLength), Schema.isTrimmed()),
);

const EnvironmentProfile = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.environmentProfileMaxLength), Schema.isTrimmed()),
);

/**
 * Captured stdout/stderr, bounded. Anything longer belongs in the evidence bundle; what
 * rides the protocol is the excerpt ein is expected to read.
 */
const CapturedOutput = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(schemaLimits.feedbackCapturedOutputMaxLength)),
);

const ScenarioText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.qaScenarioTextMaxLength), Schema.isTrimmed()),
);

const CheckName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.ciCheckNameMaxLength), Schema.isTrimmed()),
);

/**
 * How a validator process ended.
 *
 * Timeout is its own case rather than an exit code, because a timed-out hook must have its
 * whole process group killed and consume that stage's attempt budget — behaviour that
 * cannot be recovered from an exit status after the fact.
 */
export const ProcessOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("exited"), code: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("signalled"), signal: CheckName }),
  Schema.Struct({ kind: Schema.Literal("timed_out"), afterMilliseconds: Schema.Int }),
]);
export type ProcessOutcome = typeof ProcessOutcome.Type;

/** One mandatory repository validator executed against the clean-room worktree (`docs/capabilities/08-local-validation.md`). */
export const ValidatorRun = Schema.Struct({
  command: Command,
  environmentProfile: EnvironmentProfile,
  startedAt: Timestamp,
  endedAt: Timestamp,
  outcome: ProcessOutcome,
  capturedOutput: CapturedOutput,
  artifactPaths: Schema.Array(EvidenceArtifactPath),
});
export type ValidatorRun = typeof ValidatorRun.Type;

/** One external check observed on the pull request head ("Swordfish connects outbound only" (ADR 0013)). */
export const CiCheckResult = Schema.Struct({
  name: CheckName,
  outcome: GateOutcome,
  detailsUrl: Schema.optionalKey(Schema.String),
});
export type CiCheckResult = typeof CiCheckResult.Type;

export const qaScenarioResults = ["passed", "failed", "skipped"] as const;
export const QaScenarioResult = Schema.Literals(qaScenarioResults);
export type QaScenarioResult = typeof QaScenarioResult.Type;

/** One QA scenario faye executed, with what it expected and what it saw (`docs/capabilities/10-qa.md`). */
export const QaScenarioOutcome = Schema.Struct({
  id: QaScenarioId,
  description: ScenarioText,
  expectedOutcome: ScenarioText,
  observedOutcome: ScenarioText,
  result: QaScenarioResult,
  artifactPaths: Schema.Array(EvidenceArtifactPath),
});
export type QaScenarioOutcome = typeof QaScenarioOutcome.Type;

export const unstructuredFeedbackReasons = [
  "agent_produced_no_output",
  "agent_output_failed_schema_validation",
  "stage_aborted_before_output",
  "stage_infrastructure_failure",
] as const;
export const UnstructuredFeedbackReason = Schema.Literals(unstructuredFeedbackReasons);
export type UnstructuredFeedbackReason = typeof UnstructuredFeedbackReason.Type;

/**
 * A stage that failed to produce the structured result its gate requires.
 *
 * This is the detectable error. A jet that answers with prose instead of findings, or whose
 * output does not decode, produces this — never an empty `findings` array, which would be
 * indistinguishable from a clean review.
 */
export const UnstructuredFeedback = Schema.Struct({
  kind: Schema.Literal("unstructured"),
  reason: UnstructuredFeedbackReason,
  detail: CapturedOutput,
});
export type UnstructuredFeedback = typeof UnstructuredFeedback.Type;

export const ValidatorFeedback = Schema.Struct({
  kind: Schema.Literal("validator"),
  runs: Schema.Array(ValidatorRun).pipe(Schema.check(Schema.isMinLength(1))),
});

export const ExternalCiFeedback = Schema.Struct({
  kind: Schema.Literal("external_ci"),
  checks: Schema.Array(CiCheckResult).pipe(Schema.check(Schema.isMinLength(1))),
});

export const ReviewFeedback = Schema.Struct({
  kind: Schema.Literal("review"),
  findings: Schema.Array(ReviewFinding),
});

export const QaFeedback = Schema.Struct({
  kind: Schema.Literal("qa"),
  scenarios: Schema.Array(QaScenarioOutcome).pipe(Schema.check(Schema.isMinLength(1))),
});

export const GateFeedback = Schema.Union([
  ValidatorFeedback,
  ExternalCiFeedback,
  ReviewFeedback,
  QaFeedback,
  UnstructuredFeedback,
]);
export type GateFeedback = typeof GateFeedback.Type;

/**
 * The structured feedback kind each gate produces when it produces one at all.
 *
 * `evidence_upload` has no agent output of its own: it either succeeds or fails as
 * infrastructure, so its only legal feedback is `unstructured`.
 */
export const gateFeedbackKinds = {
  local_validation: "validator",
  pr_ci: "external_ci",
  code_review: "review",
  qa: "qa",
  evidence_upload: undefined,
} as const satisfies Record<CandidateGate, GateFeedback["kind"] | undefined>;

/** Whether this feedback may accompany this gate. `unstructured` is always permitted. */
export function isFeedbackForGate(gate: CandidateGate, feedback: GateFeedback): boolean {
  return feedback.kind === "unstructured" || feedback.kind === gateFeedbackKinds[gate];
}

/**
 * What ein receives in order to revise (`docs/capabilities/06-autonomous-implementation.md`).
 *
 * Assembled by Swordfish from the feedback of every gate bound to one candidate, and
 * injected into ein's prompt by the plugin. Two consumers, so it is a contract rather than
 * a Swordfish-local type — even though it never crosses the Bebop protocol itself.
 */
export const FeedbackPacket = Schema.Struct({
  candidateSha: GitSha,
  specRevision: SpecRevision,
  assembledAt: Timestamp,
  entries: Schema.Array(
    Schema.Struct({
      gate: CandidateGate,
      outcome: GateOutcome,
      feedback: GateFeedback,
    }),
  ).pipe(Schema.check(Schema.isMinLength(1))),
}).pipe(
  Schema.check(
    Schema.makeFilter<{
      readonly entries: ReadonlyArray<{ readonly gate: CandidateGate; readonly feedback: GateFeedback }>;
    }>((packet) => {
      const mismatched = packet.entries.find((entry) => !isFeedbackForGate(entry.gate, entry.feedback));
      return mismatched === undefined
        ? undefined
        : { path: ["entries"], issue: `Expected feedback matching the ${mismatched.gate} gate` };
    }),
  ),
);
export type FeedbackPacket = typeof FeedbackPacket.Type;
