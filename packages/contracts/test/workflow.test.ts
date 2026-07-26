import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  AgentDisposition,
  BountyStatus,
  CandidateGate,
  CandidateInvalidationReason,
  GateOutcome,
  GateStatus,
  LeaseOwner,
  SeatRole,
  SwordfishStage,
  VerificationStage,
  agentDispositions,
  bountyStatuses,
  leaseOwners,
  seatRoles,
  swordfishStages,
  verificationStages,
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

  test.each(leaseOwners)("decodes lease owner %s", (owner) => {
    expect(Schema.decodeUnknownSync(LeaseOwner)(owner)).toBe(owner);
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

  test("rejects unknown and differently cased values", () => {
    expect(() => Schema.decodeUnknownSync(BountyStatus)("paused")).toThrow();
    expect(() => Schema.decodeUnknownSync(SwordfishStage)("IMPLEMENTING")).toThrow();
    expect(() => Schema.decodeUnknownSync(SeatRole)("ed")).toThrow();
    expect(() => Schema.decodeUnknownSync(LeaseOwner)("bebop")).toThrow();
    expect(() => Schema.decodeUnknownSync(AgentDisposition)("ready")).toThrow();
    expect(() => Schema.decodeUnknownSync(VerificationStage)("implementation")).toThrow();
    expect(() => Schema.decodeUnknownSync(VerificationStage)("evidence_upload")).toThrow();
  });
});
