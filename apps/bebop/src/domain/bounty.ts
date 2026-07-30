// The bounty record Bebop is authoritative for (SPEC section 9.1), and the rule that turns
// it plus a Swordfish stage into the compact status in SPEC section 17.5.

import type {
  BountyId,
  BountyStatus,
  ComputeProfile,
  GitRef,
  RepositorySlug,
  SwordfishFreshnessStatus,
  SwordfishStage,
  Timestamp,
  VmId,
} from "@bebop/contracts";

/**
 * The part of a bounty's life that Bebop, not Swordfish, decides.
 *
 * It is stored and the compact `BountyStatus` is derived, rather than the other way round.
 * A stored status would have to be rewritten on every projection update, and the first
 * update that forgot would leave `bounty list` disagreeing with `bounty status` forever.
 */
export const bountyLifecycleStates = [
  "provisioning",
  "active",
  "stopping",
  "stopped",
  "merging",
  "done",
  "destroying",
  "destroyed",
  "failed",
] as const;
export type BountyLifecycleState = (typeof bountyLifecycleStates)[number];

export interface BountyRecord {
  readonly bountyId: BountyId;
  readonly repository: RepositorySlug;
  readonly baseRef: GitRef;
  readonly assignedBranch: GitRef;
  readonly computeProfile: ComputeProfile;
  readonly primaryContext: ReadonlyArray<string>;
  readonly initialPrompt?: string;
  readonly lifecycleState: BountyLifecycleState;
  readonly lifecycleDetail?: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface VmMapping {
  readonly bountyId: BountyId;
  readonly vmId: VmId;
  readonly createdAt: Timestamp;
  readonly destroyedAt?: Timestamp;
}

/** The assigned working branch for a bounty (SPEC section 2: `bounty/<bounty-id>`). */
export function assignedBranchFor(bountyId: BountyId): string {
  return `bounty/${bountyId}`;
}

/**
 * The compact status a client sees.
 *
 * Bebop's own lifecycle wins wherever it has an opinion, because it owns provisioning,
 * stopping, merging, and destruction (SPEC section 9.1). Only an `active` bounty defers to
 * the Swordfish stage — and an active bounty whose Swordfish has never registered is still
 * `provisioning`, because SPEC section 10.1 does not consider a bounty created until its
 * Swordfish connects.
 *
 * `ready` is reported from the stage alone in this milestone. SPEC section 9.4 requires
 * Bebop to verify the branch head, the checks, and the spec revision before exposing merge;
 * that verification arrives with GitHub in Milestone 10, and until then readiness is
 * presented as what it is — Swordfish's claim.
 */
export function deriveBountyStatus(
  lifecycleState: BountyLifecycleState,
  stage: SwordfishStage | null,
  freshness: SwordfishFreshnessStatus,
): BountyStatus {
  switch (lifecycleState) {
    case "provisioning":
      return "provisioning";
    case "stopping":
    case "stopped":
    case "destroying":
    case "destroyed":
      return "stopped";
    case "merging":
      return "merging";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "active":
      break;
  }

  if (stage === null) {
    return "provisioning";
  }
  let stageStatus: BountyStatus;
  switch (stage) {
    case "interactive":
      stageStatus = "interactive";
      break;
    case "human_controlled":
      stageStatus = "human_controlled";
      break;
    case "needs_attention":
    case "blocked":
      stageStatus = "needs_attention";
      break;
    case "ready":
      stageStatus = "ready";
      break;
    case "cancelling":
    case "cancelled":
      stageStatus = "stopped";
      break;
    case "failed":
      stageStatus = "failed";
      break;
    default:
      stageStatus = "autonomous";
  }

  return (freshness === "stale" || freshness === "disconnected") &&
    stageStatus !== "stopped" &&
    stageStatus !== "failed"
    ? "needs_attention"
    : stageStatus;
}
