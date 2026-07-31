import type { SwordfishStage } from "@bebop/contracts";
import { BountyId } from "@bebop/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import type { BountyLifecycleState } from "#src/domain/bounty.ts";
import { assignedBranchFor, deriveBountyStatus } from "#src/domain/bounty.ts";

const bountyId = Schema.decodeUnknownSync(BountyId)("bty-01jz8j3d9f4x");

describe("bounty status derivation", () => {
  test("names the assigned branch from the bounty id", () => {
    expect(assignedBranchFor(bountyId)).toBe(`bounty/${bountyId}`);
  });

  test("Bebop's own lifecycle wins wherever it has an opinion", () => {
    const cases: ReadonlyArray<readonly [BountyLifecycleState, SwordfishStage | null, string]> = [
      ["provisioning", null, "provisioning"],
      // A stopping bounty is stopped to a client even if its last event said `implementing`:
      // Bebop owns lifecycle commands (`docs/design/SYSTEM.md` §9.1).
      ["stopping", "implementing", "stopped"],
      ["stopped", "implementing", "stopped"],
      ["destroying", "ready", "stopped"],
      ["destroyed", "ready", "stopped"],
      ["merging", "ready", "merging"],
      ["done", "ready", "done"],
      ["failed", "implementing", "failed"],
    ];
    for (const [lifecycle, stage, expected] of cases) {
      expect(deriveBountyStatus(lifecycle, stage, "connected")).toBe(expected);
    }
  });

  test("an active bounty whose Swordfish has never registered is still provisioning", () => {
    // `docs/design/SYSTEM.md` §10.1 does not consider a bounty created until its Swordfish connects, so a
    // VM with no supervisor on it is not yet something a user can work with.
    expect(deriveBountyStatus("active", null, "never_connected")).toBe("provisioning");
  });

  test("an active bounty reports the stage its Swordfish is in", () => {
    const cases: ReadonlyArray<readonly [SwordfishStage, string]> = [
      ["interactive", "interactive"],
      ["implementing", "autonomous"],
      ["local_validation", "autonomous"],
      ["pushed_candidate", "autonomous"],
      ["pr_ci", "autonomous"],
      ["code_review", "autonomous"],
      ["qa_preparing", "autonomous"],
      ["qa_running", "autonomous"],
      ["evidence_upload", "autonomous"],
      ["revision", "autonomous"],
      ["human_controlled", "human_controlled"],
      ["needs_attention", "needs_attention"],
      ["blocked", "needs_attention"],
      ["ready", "ready"],
      ["cancelling", "stopped"],
      ["cancelled", "stopped"],
      ["failed", "failed"],
    ];
    for (const [stage, expected] of cases) {
      expect(deriveBountyStatus("active", stage, "connected")).toBe(expected);
    }
  });

  test("does not present stale or disconnected work as active or ready", () => {
    for (const freshness of ["stale", "disconnected"] as const) {
      expect(deriveBountyStatus("active", "implementing", freshness)).toBe("needs_attention");
      expect(deriveBountyStatus("active", "ready", freshness)).toBe("needs_attention");
      expect(deriveBountyStatus("active", "cancelled", freshness)).toBe("stopped");
    }
  });
});
