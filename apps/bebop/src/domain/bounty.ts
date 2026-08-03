// The bounty record Bebop is authoritative for ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)), and the rule that turns
// it plus a Swordfish stage into the compact status in `docs/capabilities/01-bounty-lifecycle.md`.

import type {
  BountyId,
  BountyStatus,
  ComputeProfile,
  Controller,
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

/** The assigned working branch for a bounty ("The bounty primitive" (ADR 0001): `bounty/<bounty-id>`). */
export function assignedBranchFor(bountyId: BountyId): string {
  return `bounty/${bountyId}`;
}

/**
 * The compact status a client sees.
 *
 * Bebop's own lifecycle wins wherever it has an opinion, because it owns provisioning,
 * stopping, merging, and destruction ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)). Only an `active` bounty defers to
 * the Swordfish stage — and an active bounty whose Swordfish has never registered is still
 * `provisioning`, because provisioning is not finished until its Swordfish connects
 * (`docs/capabilities/02-provisioning-and-attachment.md`).
 *
 * `ready` is reported from the stage alone today. "Readiness is a claim, not authority"
 * (ADR 0003) requires Bebop to verify the branch head, the checks, and the spec revision
 * before exposing merge;
 * that verification arrives with GitHub (`docs/capabilities/12-pull-request-and-merge.md`),
 * and until then readiness is presented as what it is — Swordfish's claim.
 */
export function deriveBountyStatus(
  lifecycleState: BountyLifecycleState,
  stage: SwordfishStage | null,
  controller: Controller,
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
    case "needs_attention":
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

  // `human_controlled` is derived here rather than reported by Swordfish ("One controller drives one active
  // cowboy" (ADR 0037)). It outranks `needs_attention` and every working stage because those describe what the
  // bounty is doing, and a human already driving it is the more useful thing to say — nobody needs to be told
  // that a bounty someone is actively steering requires attention. It does not outrank Bebop's own terminal
  // opinions, which were returned above.
  if (controller === "human" && stageStatus !== "stopped" && stageStatus !== "failed") {
    return "human_controlled";
  }

  return (freshness === "stale" || freshness === "disconnected") &&
    stageStatus !== "stopped" &&
    stageStatus !== "failed"
    ? "needs_attention"
    : stageStatus;
}
