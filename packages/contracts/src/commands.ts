// Command payloads carried by BOTH the Bebop-Swordfish WebSocket protocol and the local
// `sf` control socket.
//
// ## Versioning policy
//
// These two protocols version independently — `currentProtocolVersion` in `scalars.ts` and
// `currentSfControlVersion` in `sf-control.ts` — but they share these payload shapes. That
// means a change here is a breaking change to two contracts at once.
//
// **Changing anything in this module bumps both version constants together.**
//
// The reuse is deliberate and worth keeping: `sf takeover` and a Bebop-issued takeover are
// the same operation reaching Swordfish by different transports, and giving them separate
// schemas would let them drift. What the reuse costs is that the golden fixtures cannot
// catch the mistake: each protocol's fixtures round-trip only its own messages, so adding a
// field to `TakeoverCommand` for the WebSocket protocol silently changes the local socket
// contract while every existing test still passes. `commands.test.ts` is the tripwire —
// it pins both version constants alongside the encoded shape of every command in this file,
// so editing one without the other fails.

import { Schema } from "effect";

import { ConstraintKey } from "./constraints.ts";
import { schemaLimits } from "./settings.ts";
import { SeatRole, VerificationStage } from "./workflow.ts";

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

export const ExtendConstraintCommand = Schema.Struct({
  type: Schema.Literal("extend_constraint"),
  constraint: ConstraintKey,
});
export type ExtendConstraintCommand = typeof ExtendConstraintCommand.Type;

export const RetryStageCommand = Schema.Struct({
  type: Schema.Literal("retry_stage"),
  stage: VerificationStage,
});
export type RetryStageCommand = typeof RetryStageCommand.Type;

/** Every command shape shared by the two protocols, for the coupling tripwire. */
export const sharedCommands = {
  StopCommand,
  TakeoverCommand,
  ExtendConstraintCommand,
  RetryStageCommand,
} as const;
