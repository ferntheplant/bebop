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

/**
 * What work the bounty is doing — and only that.
 *
 * "One controller drives one active cowboy" (ADR 0037) makes stage and controller orthogonal, so no stage means
 * "a human is driving": that is `Controller` below, and `human_controlled` is derived by Bebop rather than
 * reported by Swordfish. `blocked` is likewise absent — an agent reporting itself blocked raises an attention
 * record and moves the stage to `needs_attention`, so the reason a stage stopped lives in `AttentionKind`
 * rather than in a second suspending stage that carries no reason at all.
 *
 * `needs_attention` remains a stage because attention genuinely suspends the work: the stage to resume into is
 * recorded separately and replayed when the attention clears.
 */
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
  "needs_attention",
  "cancelling",
  "cancelled",
  "failed",
] as const;
export const SwordfishStage = Schema.Literals(swordfishStages);
export type SwordfishStage = typeof SwordfishStage.Type;

export const seatRoles = ["ein", "jet", "faye"] as const;
export const SeatRole = Schema.Literals(seatRoles);
export type SeatRole = typeof SeatRole.Type;

/**
 * Who is responsible for directing the current stage ("One controller drives one active cowboy" (ADR 0037)).
 *
 * This replaces the per-seat lease owner. A lease said who held one seat, which meant control had to be
 * reassembled by scanning every seat and could disagree with itself; a controller is one value for the whole
 * workflow, and a human-control episode follows manually requested transitions until explicit handoff.
 */
export const controllers = ["swordfish", "human"] as const;
export const Controller = Schema.Literals(controllers);
export type Controller = typeof Controller.Type;

/**
 * Why control changed hands, recorded as provenance ("Control passes through a quiescent handoff" (ADR 0036)).
 *
 * `forced` is distinct from `takeover` because a forced restart that fails leaves the workflow under human
 * control and degraded rather than returning uncertain authority to Swordfish, and status has to be able to say
 * so.
 */
export const controlChangeReasons = ["takeover", "forced_takeover", "handoff", "attention"] as const;
export const ControlChangeReason = Schema.Literals(controlChangeReasons);
export type ControlChangeReason = typeof ControlChangeReason.Type;

export const agentDispositions = ["candidate_ready", "blocked", "continue"] as const;
export const AgentDisposition = Schema.Literals(agentDispositions);
export type AgentDisposition = typeof AgentDisposition.Type;

/**
 * Why a bounty stopped and needs a human.
 *
 * The kind exists so that an attention record can name its own exits: `docs/capabilities/05-control-lease-and-takeover.md`
 * promises that status prints the exact command which resolves the attention, and a free-text reason cannot be
 * turned back into a command. `agent_blocked` is what the `blocked` agent disposition becomes once it reaches
 * the workflow — a reason attached to `needs_attention`, not a stage of its own.
 */
export const attentionKinds = [
  "agent_blocked",
  "constraint_exhausted",
  "config_approval",
  "intrusion",
  "uncertain_seat",
  "uncertain_gate",
  "environment",
  "operational",
] as const;
export const AttentionKind = Schema.Literals(attentionKinds);
export type AttentionKind = typeof AttentionKind.Type;

/**
 * The actions that may clear an attention record ("Workflow actions have role-aware adapters" (ADR 0038)).
 *
 * Each record declares its own permitted subset, because a generic resume must not clear a budget exhaustion:
 * `resume` changes no allowance, while reviving an exhausted attempt is `continue` or `rerun`
 * ("Continue preserves an attempt; rerun replaces it" (ADR 0041)). `approve_config` is bebop-side authority and
 * appears here only so the record can point at it.
 */
export const workflowResolutions = ["resume", "continue", "rerun", "takeover", "cancel", "approve_config"] as const;
export const WorkflowResolution = Schema.Literals(workflowResolutions);
export type WorkflowResolution = typeof WorkflowResolution.Type;

/**
 * The permitted exits for each kind of attention.
 *
 * Held here rather than at each raise site so that the answer cannot drift between the seat that raises the
 * attention, the status that prints its exits, and the reducer that decides whether a resolution is admissible.
 */
export const resolutionsForAttention: Readonly<Record<AttentionKind, ReadonlyArray<WorkflowResolution>>> = {
  // The agent stopped and said why. Nothing is exhausted, so a plain resume is enough; a human who would rather
  // steer it themselves may take over instead.
  agent_blocked: ["resume", "takeover", "cancel"],
  // A budget ran out. `resume` is deliberately absent: reviving the attempt is a grant, and grants are explicit.
  constraint_exhausted: ["continue", "rerun", "takeover", "cancel"],
  config_approval: ["approve_config", "cancel"],
  // Something already executed that Swordfish did not originate. Detection does not roll it back, so the exits
  // are to inspect it under human control or to give up ("The control lease blocks mixed model turns, not
  // trusted cockpit input" (ADR 0039)).
  intrusion: ["takeover", "cancel"],
  uncertain_seat: ["takeover", "cancel"],
  // The gate may or may not have run against the candidate, so the only honest exit is to run it again.
  uncertain_gate: ["rerun", "takeover", "cancel"],
  environment: ["cancel"],
  operational: ["resume", "takeover", "cancel"],
};

export const verificationStages = ["local_validation", "pr_ci", "code_review", "qa"] as const;
export const VerificationStage = Schema.Literals(verificationStages);
export type VerificationStage = typeof VerificationStage.Type;

export const candidateGates = ["local_validation", "pr_ci", "code_review", "qa", "evidence_upload"] as const;
export const CandidateGate = Schema.Literals(candidateGates);
export type CandidateGate = typeof CandidateGate.Type;

export const gateStatuses = ["not_started", "pending", "passed", "failed"] as const;
export const GateStatus = Schema.Literals(gateStatuses);
export type GateStatus = typeof GateStatus.Type;

export const gateOutcomes = ["passed", "failed"] as const;
export const GateOutcome = Schema.Literals(gateOutcomes);
export type GateOutcome = typeof GateOutcome.Type;

export const candidateInvalidationReasons = ["new_commit", "branch_head_changed", "spec_revised"] as const;
export const CandidateInvalidationReason = Schema.Literals(candidateInvalidationReasons);
export type CandidateInvalidationReason = typeof CandidateInvalidationReason.Type;
