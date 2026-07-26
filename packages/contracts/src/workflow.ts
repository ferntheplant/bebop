import { Schema } from "effect";

export const bountyStatuses = [
  "provisioning",
  "interactive",
  "autonomous",
  "human_controlled",
  "needs_attention",
  "ready",
  "merging",
  "done",
  "failed",
  "stopped",
] as const;
export const BountyStatus = Schema.Literals(bountyStatuses);
export type BountyStatus = typeof BountyStatus.Type;

export const swordfishStages = [
  "interactive",
  "implementing",
  "local_validation",
  "pushed_candidate",
  "pr_ci",
  "code_review",
  "qa_preparing",
  "qa_running",
  "evidence_upload",
  "ready",
  "revision",
  "human_controlled",
  "needs_attention",
  "blocked",
  "cancelling",
  "cancelled",
  "failed",
] as const;
export const SwordfishStage = Schema.Literals(swordfishStages);
export type SwordfishStage = typeof SwordfishStage.Type;

export const seatRoles = ["ein", "jet", "faye"] as const;
export const SeatRole = Schema.Literals(seatRoles);
export type SeatRole = typeof SeatRole.Type;

export const leaseOwners = ["human", "swordfish"] as const;
export const LeaseOwner = Schema.Literals(leaseOwners);
export type LeaseOwner = typeof LeaseOwner.Type;

export const agentDispositions = ["candidate_ready", "blocked", "continue"] as const;
export const AgentDisposition = Schema.Literals(agentDispositions);
export type AgentDisposition = typeof AgentDisposition.Type;

export const verificationStages = ["local_validation", "pr_ci", "code_review", "qa"] as const;
export const VerificationStage = Schema.Literals(verificationStages);
export type VerificationStage = typeof VerificationStage.Type;
