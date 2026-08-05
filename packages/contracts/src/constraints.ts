// The autonomy budget a repository sets and Swordfish freezes for a bounty
// (`docs/capabilities/07-repository-configuration.md`).
//
// Constraints are scoped circuit breakers, not one bounty-lifetime counter. What resets a scope is the thing the
// scope is named for: a build cycle, a candidate, or a spec revision. The flat per-key ledger this replaces had
// one counter per limit with no scope at all, so nothing reset and every limit was extended by the same
// `limit_value + 1` rule regardless of what it measured.

import { Schema } from "effect";

import { ConstraintLimit } from "./scalars.ts";
import { defaultConstraintValues } from "./settings.ts";
import type { RerunTarget, SeatRole } from "./workflow.ts";

/**
 * The three scopes that bound autonomous work, each named for the cowboy role it governs.
 *
 * A scope is derivable from the active cowboy's role rather than declared alongside it — ein builds, jet reviews,
 * faye runs QA — which is what makes an attempt with no cowboy unrepresentable.
 */
export const constraintScopes = ["building", "review", "qa"] as const;
export const ConstraintScope = Schema.Literals(constraintScopes);
export type ConstraintScope = typeof ConstraintScope.Type;

/**
 * What a constraint measures, which is also the unit its consumed and allowed values are in.
 *
 * This replaces the flat `ConstraintKey`, whose eight values crossed a scope with a measure (`review_turns`) and
 * so could name neither on its own. A kind plus a scope says the same thing and stays a fixed set of four as
 * scopes come and go.
 */
export const constraintKinds = ["turns", "wall_clock", "attempts", "validated_candidates"] as const;
export const ConstraintKind = Schema.Literals(constraintKinds);
export type ConstraintKind = typeof ConstraintKind.Type;

/** The scope a cowboy's attempts are counted against. */
export const constraintScopeForRole: Readonly<Record<SeatRole, ConstraintScope>> = {
  ein: "building",
  jet: "review",
  faye: "qa",
};

/**
 * The scope a `rerun` target grants an attempt in, or null when it grants none.
 *
 * `rerun validation` repeats a deterministic operation against the same SHA, so it is deliberately not an
 * attempt in any scope ("A rerun resolves the kind its target names" (ADR 0043)).
 */
export function scopeForRerunTarget(target: RerunTarget): ConstraintScope | null {
  return target === "validation" ? null : target;
}

/** The watchdog pair every attempt carries, whatever its scope. */
const AttemptWatchdogs = {
  turnsPerAttempt: ConstraintLimit,
  wallClockMinutesPerAttempt: ConstraintLimit,
} as const;

/**
 * Ein's scope. Its allowance is per build cycle, which begins at a confirmed spec or downstream feedback and
 * ends when one candidate passes local validation and CI.
 */
export const BuildingConstraintProfile = Schema.Struct({
  attemptsPerCycle: ConstraintLimit,
  ...AttemptWatchdogs,
});
export type BuildingConstraintProfile = typeof BuildingConstraintProfile.Type;

/**
 * Jet's and faye's scope. Their allowance is per candidate, because each attempt takes a fresh seat and a new
 * candidate is a new thing to judge.
 */
export const CandidateConstraintProfile = Schema.Struct({
  attemptsPerCandidate: ConstraintLimit,
  ...AttemptWatchdogs,
});
export type CandidateConstraintProfile = typeof CandidateConstraintProfile.Type;

export const ConstraintProfile = Schema.Struct({
  validatedCandidatesPerSpec: ConstraintLimit,
  building: BuildingConstraintProfile,
  review: CandidateConstraintProfile,
  qa: CandidateConstraintProfile,
});
export type ConstraintProfile = typeof ConstraintProfile.Type;

/**
 * The attempt allowance for one scope.
 *
 * The two field names differ because they say what resets them, and that difference is the whole of the
 * building/candidate distinction in the configuration file a repository author writes. This function is the one
 * place that has to know about it, so nothing else does.
 */
export function attemptAllowance(profile: ConstraintProfile, scope: ConstraintScope): number {
  return scope === "building" ? profile.building.attemptsPerCycle : profile[scope].attemptsPerCandidate;
}

/** The turn and wall-clock watchdogs for one scope. */
export function attemptWatchdogs(
  profile: ConstraintProfile,
  scope: ConstraintScope,
): { readonly turns: number; readonly wallClockMinutes: number } {
  const scoped = profile[scope];
  return { turns: scoped.turnsPerAttempt, wallClockMinutes: scoped.wallClockMinutesPerAttempt };
}

export const defaultConstraintProfile = Schema.decodeUnknownSync(ConstraintProfile)(defaultConstraintValues);
