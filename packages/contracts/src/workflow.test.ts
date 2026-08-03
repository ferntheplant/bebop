import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  AgentDisposition,
  AttentionKind,
  BountyStatus,
  CandidateGate,
  CandidateInvalidationReason,
  GateOutcome,
  GateStatus,
  SeatRole,
  SwordfishStage,
  VerificationStage,
  WorkflowResolution,
  agentDispositions,
  attentionKinds,
  bountyStatuses,
  Controller,
  controllers,
  kindForRerunTarget,
  resolutionsForAttention,
  rerunTargets,
  seatRoles,
  swordfishStages,
  verificationStages,
  workflowResolutions,
} from "#src/workflow.ts";

describe("workflow vocabulary", () => {
  test.each(bountyStatuses)("decodes bounty status %s", (status) => {
    expect(Schema.decodeUnknownSync(BountyStatus)(status)).toBe(status);
  });

  test.each(swordfishStages)("decodes swordfish stage %s", (stage) => {
    expect(Schema.decodeUnknownSync(SwordfishStage)(stage)).toBe(stage);
  });

  test.each(seatRoles)("decodes seat role %s", (role) => {
    expect(Schema.decodeUnknownSync(SeatRole)(role)).toBe(role);
  });

  test.each(controllers)("decodes controller %s", (controller) => {
    expect(Schema.decodeUnknownSync(Controller)(controller)).toBe(controller);
  });

  test.each(attentionKinds)("decodes attention kind %s", (kind) => {
    expect(Schema.decodeUnknownSync(AttentionKind)(kind)).toBe(kind);
  });

  test.each(workflowResolutions)("decodes workflow resolution %s", (resolution) => {
    expect(Schema.decodeUnknownSync(WorkflowResolution)(resolution)).toBe(resolution);
  });

  test.each(agentDispositions)("decodes agent disposition %s", (disposition) => {
    expect(Schema.decodeUnknownSync(AgentDisposition)(disposition)).toBe(disposition);
  });

  test.each(verificationStages)("decodes verification stage %s", (stage) => {
    expect(Schema.decodeUnknownSync(VerificationStage)(stage)).toBe(stage);
  });

  test.each(["local_validation", "pr_ci", "code_review", "qa", "evidence_upload"] as const)(
    "decodes candidate gate %s",
    (gate) => {
      expect(Schema.decodeUnknownSync(CandidateGate)(gate)).toBe(gate);
    },
  );

  test("decodes gate state and candidate invalidation vocabulary", () => {
    expect(Schema.decodeUnknownSync(GateStatus)("pending")).toBe("pending");
    expect(Schema.decodeUnknownSync(GateOutcome)("passed")).toBe("passed");
    expect(Schema.decodeUnknownSync(CandidateInvalidationReason)("branch_head_changed")).toBe("branch_head_changed");
  });

  test("no stage encodes control or a reason for stopping", () => {
    // "One controller drives one active cowboy" (ADR 0037) took `human_controlled` out of the stage enum, and
    // `blocked` became an attention kind rather than a second reasonless suspension. A stage list that grows one
    // of them back is the regression this guards.
    expect(swordfishStages).not.toContain("human_controlled");
    expect(swordfishStages).not.toContain("blocked");
    expect(swordfishStages).toContain("needs_attention");
  });

  test("every attention kind offers at least one exit, and only permitted ones", () => {
    // `docs/capabilities/05-control-lease-and-takeover.md` promises status names the command that resolves an
    // attention. A kind with no exits would strand a bounty with nothing to print.
    for (const kind of attentionKinds) {
      const resolutions = resolutionsForAttention[kind];
      expect(resolutions.length).toBeGreaterThan(0);
      for (const resolution of resolutions) {
        expect(workflowResolutions).toContain(resolution);
      }
    }
  });

  test("an exhausted budget cannot be cleared by a plain resume", () => {
    // The distinction "Continue preserves an attempt; rerun replaces it" (ADR 0041) rests on: `resume` changes
    // no allowance, so it must not appear against a kind whose recovery is a grant.
    expect(resolutionsForAttention.constraint_exhausted).not.toContain("resume");
    expect(resolutionsForAttention.constraint_exhausted).toContain("continue");
    expect(resolutionsForAttention.constraint_exhausted).toContain("rerun");
  });

  test("every rerun target names a kind that permits rerun", () => {
    // The map is what stops a targeted `rerun` from clearing a record nobody addressed
    // ("A rerun resolves the kind its target names" (ADR 0043)). A target pointing at a kind that does not
    // permit `rerun` would name a record the reducer then refuses to clear — a command that can never succeed.
    for (const target of rerunTargets) {
      const kind = kindForRerunTarget[target];
      expect(attentionKinds).toContain(kind);
      expect(resolutionsForAttention[kind]).toContain("rerun");
    }
    // Exactly the two kinds that permit `rerun` are reachable, so no kind offering the exit is unresolvable.
    expect(new Set(Object.values(kindForRerunTarget))).toEqual(new Set(["constraint_exhausted", "uncertain_gate"]));
  });

  test("only a validation rerun answers an uncertain gate", () => {
    // An uncertain *seat* is a separate kind that permits no rerun at all, which is what makes the target-to-kind
    // map total rather than ambiguous for the three cowboy scopes.
    expect(kindForRerunTarget.validation).toBe("uncertain_gate");
    expect(resolutionsForAttention.uncertain_seat).not.toContain("rerun");
    for (const scope of ["building", "review", "qa"] as const) {
      expect(kindForRerunTarget[scope]).toBe("constraint_exhausted");
    }
  });

  test("rejects unknown and differently cased values", () => {
    expect(() => Schema.decodeUnknownSync(BountyStatus)("paused")).toThrow();
    expect(() => Schema.decodeUnknownSync(SwordfishStage)("IMPLEMENTING")).toThrow();
    expect(() => Schema.decodeUnknownSync(SeatRole)("ed")).toThrow();
    expect(() => Schema.decodeUnknownSync(Controller)("bebop")).toThrow();
    expect(() => Schema.decodeUnknownSync(AgentDisposition)("ready")).toThrow();
    expect(() => Schema.decodeUnknownSync(VerificationStage)("implementation")).toThrow();
    expect(() => Schema.decodeUnknownSync(VerificationStage)("evidence_upload")).toThrow();
  });
});
