// Command payloads carried by the Bebop-Swordfish WebSocket protocol, most of which are
// also carried by the local `sf` control socket.
//
// ## Versioning policy
//
// These two protocols version independently — `currentProtocolVersion` in `scalars.ts` and
// `currentSfControlVersion` in `sf-control.ts` — but they share most payload shapes. That
// means a change here is a breaking change to two contracts at once.
//
// **Changing a schema listed in `sharedCommands` bumps both version constants together.**
//
// The reuse is deliberate and worth keeping: `sf takeover` and a Bebop-issued takeover are
// the same operation reaching Swordfish by different transports, and giving them separate
// schemas would let them drift. What the reuse costs is that the golden fixtures cannot
// catch the mistake: each protocol's fixtures round-trip only its own messages, so adding a
// field to `TakeoverCommand` for the WebSocket protocol silently changes the local socket
// contract while every existing test still passes. `commands.test.ts` is the tripwire —
// it pins both version constants alongside the encoded shape of every shared command in
// this file, so editing one without the other fails. Stop is deliberately not shared:
// Bebop `stop` owns daemon lifecycle, while local `sf cancel` leaves Swordfish alive.

import { Schema } from "effect";

import { schemaLimits } from "./settings.ts";
import { RerunTarget, SeatRole } from "./workflow.ts";

const CommandMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.protocolMessageMaxLength), Schema.isTrimmed()),
);

export const StopCommand = Schema.Struct({
  type: Schema.Literal("stop"),
  reason: Schema.optionalKey(CommandMessage),
});
export type StopCommand = typeof StopCommand.Type;

export const TakeoverCommand = Schema.Struct({
  type: Schema.Literal("takeover"),
  seat: SeatRole,
  force: Schema.Boolean,
});
export type TakeoverCommand = typeof TakeoverCommand.Type;

/**
 * Revive the suspended final attempt, resetting both its watchdogs
 * ("Continue preserves an attempt; rerun replaces it" (ADR 0041)).
 *
 * It names no scope. There is at most one attempt to revive, so a scope argument could only ever agree with the
 * state or be wrong — the same reason `TakeoverCommand`'s seat is on its way out. Both watchdogs are reset
 * together rather than singly, because reviving an attempt that remains blocked by the other dimension asks the
 * operator to issue a second command to achieve what they already asked for.
 */
export const ContinueCommand = Schema.Struct({
  type: Schema.Literal("continue"),
});
export type ContinueCommand = typeof ContinueCommand.Type;

/**
 * Abandon the suspended attempt and start fresh work at `target`.
 *
 * The target is what makes the grant specific: `building` adds an ein attempt to the current build cycle,
 * `review` and `qa` add one for the current candidate in a fresh seat, and `validation` repeats a deterministic
 * operation without consuming an attempt at all. It is also what picks the attention record this resolves
 * ("A rerun resolves the kind its target names" (ADR 0043)).
 */
export const RerunCommand = Schema.Struct({
  type: Schema.Literal("rerun"),
  target: RerunTarget,
});
export type RerunCommand = typeof RerunCommand.Type;

/**
 * Clear a safe non-budget suspension such as a cowboy's `set-blocked`.
 *
 * It preserves the attempt and changes no allowance, which is exactly why it cannot clear a
 * `constraint_exhausted`: reviving an exhausted attempt is a grant, and grants are explicit (ADR 0041). The
 * reducer enforces that from `resolutionsForAttention` rather than from anything declared here.
 */
export const ResumeCommand = Schema.Struct({
  type: Schema.Literal("resume"),
});
export type ResumeCommand = typeof ResumeCommand.Type;

/** Every command shape shared by the two protocols, for the coupling tripwire. */
export const sharedCommands = {
  TakeoverCommand,
  ContinueCommand,
  RerunCommand,
  ResumeCommand,
} as const;
