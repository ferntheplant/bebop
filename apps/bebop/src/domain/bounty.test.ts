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
      // Bebop owns lifecycle commands ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)).
      ["stopping", "implementing", "stopped"],
      ["stopped", "implementing", "stopped"],
      ["destroying", "ready", "stopped"],
      ["destroyed", "ready", "stopped"],
      ["merging", "ready", "merging"],
      ["done", "ready", "done"],
      ["failed", "implementing", "failed"],
    ];
    for (const [lifecycle, stage, expected] of cases) {
      expect(deriveBountyStatus(lifecycle, stage, "swordfish", "connected")).toBe(expected);
    }
  });

  test("an active bounty whose Swordfish has never registered is still provisioning", () => {
    // Provisioning is not finished until its Swordfish connects
    // (`docs/capabilities/02-provisioning-and-attachment.md`), so a VM with no supervisor on
    // it is not yet something a user can work with.
    expect(deriveBountyStatus("active", null, "swordfish", "never_connected")).toBe("provisioning");
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
      ["needs_attention", "needs_attention"],
      ["ready", "ready"],
      ["cancelling", "stopped"],
      ["cancelled", "stopped"],
      ["failed", "failed"],
    ];
    for (const [stage, expected] of cases) {
      expect(deriveBountyStatus("active", stage, "swordfish", "connected")).toBe(expected);
    }
  });

  test("human control is derived from the controller, not from a stage", () => {
    // `human_controlled` left the stage enum in "One controller drives one active cowboy" (ADR 0037). Swordfish
    // reports the work it is doing; whether a human is driving it is the orthogonal `controller`, and this
    // function is the only place the two are collapsed into one word for a client.
    for (const stage of ["implementing", "code_review", "qa_running", "ready"] as const) {
      expect(deriveBountyStatus("active", stage, "human", "connected")).toBe("human_controlled");
      expect(deriveBountyStatus("active", stage, "swordfish", "connected")).not.toBe("human_controlled");
    }
  });

  test("a human already driving outranks the attention that called them", () => {
    // Attention means "a human must act". Once one is acting, saying so is more useful than repeating the call.
    expect(deriveBountyStatus("active", "needs_attention", "swordfish", "connected")).toBe("needs_attention");
    expect(deriveBountyStatus("active", "needs_attention", "human", "connected")).toBe("human_controlled");
  });

  test("human control does not override Bebop's own terminal opinions", () => {
    // Bebop owns lifecycle ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)); a stopped bounty is
    // stopped no matter who last held control of its loop.
    expect(deriveBountyStatus("stopped", "implementing", "human", "connected")).toBe("stopped");
    expect(deriveBountyStatus("done", "ready", "human", "connected")).toBe("done");
    expect(deriveBountyStatus("active", "cancelled", "human", "connected")).toBe("stopped");
    expect(deriveBountyStatus("active", "failed", "human", "connected")).toBe("failed");
  });

  test("a silent Swordfish is not presented as still under human control", () => {
    // The controller is a projected fact from the last event Bebop received. Once the daemon goes quiet, Bebop
    // cannot tell whether that human is still there, so freshness overrides human control exactly as it
    // overrides every other non-terminal status ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)).
    for (const freshness of ["stale", "disconnected"] as const) {
      expect(deriveBountyStatus("active", "qa_running", "human", freshness)).toBe("needs_attention");
      expect(deriveBountyStatus("active", "ready", "human", freshness)).toBe("needs_attention");
      // Terminal stages are still exempt, under either controller.
      expect(deriveBountyStatus("active", "cancelled", "human", freshness)).toBe("stopped");
      expect(deriveBountyStatus("active", "failed", "human", freshness)).toBe("failed");
    }
    // A connected daemon still reports human control.
    expect(deriveBountyStatus("active", "qa_running", "human", "connected")).toBe("human_controlled");
  });

  test("does not present stale or disconnected work as active or ready", () => {
    for (const freshness of ["stale", "disconnected"] as const) {
      expect(deriveBountyStatus("active", "implementing", "swordfish", freshness)).toBe("needs_attention");
      expect(deriveBountyStatus("active", "ready", "swordfish", freshness)).toBe("needs_attention");
      expect(deriveBountyStatus("active", "cancelled", "swordfish", freshness)).toBe("stopped");
    }
  });
});
