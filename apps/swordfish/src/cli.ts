#!/usr/bin/env bun

import type { SfBudgetSnapshot, SfControlCommand, SfControlRequest, SfStatusSnapshot } from "@bebop/contracts";
import {
  currentSfControlVersion,
  rerunTargets,
  SfControlRequest as SfControlRequestSchema,
  SfStatusSnapshot as SfStatusSnapshotSchema,
} from "@bebop/contracts";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunStdio from "@effect/platform-bun/BunStdio";
import { Config, ConfigProvider, Console, Effect, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { requestControl } from "#src/control/client.ts";
import { SwordfishIdentity, SwordfishIdentityLayer } from "#src/domain/identity.ts";

export const swordfishCliName = "sf";

const socket = Flag.string("socket").pipe(
  Flag.withDescription("The Swordfish control socket. Defaults to $SWORDFISH_CONTROL_SOCKET_PATH."),
  Flag.optional,
);
const json = Flag.boolean("json").pipe(
  Flag.withDescription("Print the control response as JSON."),
  Flag.withDefault(false),
);
const common = { socket, json };

const CliEnvironment = Config.schema(Schema.Struct({ controlSocketPath: Schema.String }), "swordfish");

function loadSocketPath(override: Option.Option<string>) {
  if (Option.isSome(override)) return Effect.succeed(override.value);
  return CliEnvironment.parse(ConfigProvider.fromEnv().pipe(ConfigProvider.constantCase)).pipe(
    Effect.map((environment) => environment.controlSocketPath),
  );
}

function printStatus(snapshot: SfStatusSnapshot): string {
  const lines = [
    `bounty      ${snapshot.bountyId}`,
    `vm          ${snapshot.vmId}`,
    `repository  ${snapshot.repository}`,
    `branch      ${snapshot.assignedBranch}`,
    `stage       ${snapshot.stage}`,
    `control     ${snapshot.controller}`,
    `bebop       ${snapshot.bebopConnection.state}`,
    `ack         ${snapshot.bebopConnection.acknowledgedThrough}`,
    `outbox      ${snapshot.bebopConnection.pendingEventCount}`,
  ];
  // A stopped bounty prints what will restart it. Reading a reason and then having to work out which command
  // applies was the step `docs/capabilities/05-control-lease-and-takeover.md` asks us to remove. Each reason
  // gets its own exits, because clearing one may leave another outstanding.
  for (const attention of snapshot.attention) {
    lines.push(`attention   ${attention.kind}: ${attention.reason}`);
    lines.push(`resolve     ${attention.resolutions.join(", ")}`);
  }
  if (snapshot.suspendedStage !== undefined) {
    lines.push(`suspended   ${snapshot.suspendedStage}`);
  }
  // Matched by seat ID, since a retried role has more than one seat in this list.
  for (const seat of snapshot.seats) {
    const active = seat.seatId === snapshot.activeCowboy?.seatId ? " (active)" : "";
    lines.push(`seat        ${seat.role} ${seat.seatId}${active}`);
  }
  // The attempt in flight, with the ordinal and the two watchdogs it is running against. A stopped clock is
  // called out because "12 minutes elapsed" reads as progress when nothing is in fact accruing.
  const attempt = snapshot.attempt;
  if (attempt !== undefined) {
    lines.push(
      `attempt     ${attempt.scope} ${attempt.ordinal} (${attempt.role} ${attempt.seatId})${attempt.running ? "" : " [clock stopped]"}`,
    );
    lines.push(`turns       ${budget(attempt.turns)}`);
    lines.push(`wall clock  ${budget(minutes(attempt.wallClockMs))} min`);
  }
  for (const constraint of snapshot.constraints) {
    lines.push(`attempts    ${constraint.scope} ${budget(constraint.attempts)}`);
  }
  lines.push(`candidates  validated ${budget(snapshot.validatedCandidates)}`);
  // What actually ran out, as the arithmetic rather than as the daemon's assertion (ADR 0042).
  for (const entry of snapshot.exhausted) {
    const scope = entry.scope === undefined ? "" : `${entry.scope} `;
    lines.push(`exhausted   ${scope}${entry.constraint} ${entry.consumed}/${entry.allowed}`);
  }
  return lines.join("\n");
}

/** `consumed/allowed`, naming a grant only when one was made, so an unextended budget stays quiet. */
function budget(value: SfBudgetSnapshot): string {
  const granted = value.granted > 0 ? ` (${value.base} + ${value.granted} granted)` : "";
  return `${value.consumed}/${value.base + value.granted}${granted}`;
}

function minutes(value: SfBudgetSnapshot): SfBudgetSnapshot {
  const toMinutes = (milliseconds: number) => Math.round(milliseconds / 60_000);
  return { consumed: toMinutes(value.consumed), base: toMinutes(value.base), granted: toMinutes(value.granted) };
}

function rejectTrailingArguments(command: SfControlCommand): Effect.Effect<void, Error> {
  const commandIndex = process.argv.indexOf(command.type);
  if (commandIndex < 0) return Effect.void;

  const positionals: Array<string> = [];
  const rest = process.argv.slice(commandIndex + 1);
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index] ?? "";
    if (value === "--socket") {
      index += 1;
    } else if (value === "--json" || value === "--force" || value.startsWith("--socket=")) {
      continue;
    } else if (!value.startsWith("-")) {
      positionals.push(value);
    }
  }
  const expected = command.type === "takeover" || command.type === "rerun" ? 1 : 0;
  return positionals.length > expected
    ? Effect.fail(new Error(`Unexpected argument: ${positionals[expected] ?? "unknown"}`))
    : Effect.void;
}

const execute = Effect.fnUntraced(function* (options: {
  readonly command: SfControlCommand;
  readonly socket: Option.Option<string>;
  readonly json: boolean;
}) {
  yield* rejectTrailingArguments(options.command);
  const identity = yield* SwordfishIdentity;
  const path = yield* loadSocketPath(options.socket);
  const request = Schema.decodeUnknownSync(SfControlRequestSchema)({
    type: "request",
    controlVersion: currentSfControlVersion,
    correlationId: yield* identity.correlationId,
    command: options.command,
  }) as SfControlRequest;
  const response = yield* requestControl(path, request).pipe(Effect.scoped);
  if (response.type === "error") return yield* Effect.fail(response.error);
  yield* Console.log(
    options.json
      ? JSON.stringify(Schema.encodeUnknownSync(SfStatusSnapshotSchema)(response.result.snapshot), null, 2)
      : printStatus(response.result.snapshot),
  );
});

const status = Command.make("status", common, (options) => execute({ ...options, command: { type: "status" } }));
const cancel = Command.make("cancel", common, (options) => execute({ ...options, command: { type: "cancel" } }));
const handoff = Command.make("handoff", common, (options) => execute({ ...options, command: { type: "handoff" } }));
const takeover = Command.make(
  "takeover",
  {
    ...common,
    seat: Argument.choice("seat", ["ein", "jet", "faye"] as const),
    force: Flag.boolean("force").pipe(Flag.withDescription("Force an interrupted takeover."), Flag.withDefault(false)),
  },
  (options) => execute({ ...options, command: { type: "takeover", seat: options.seat, force: options.force } }),
);
// The three recovery verbs, deliberately distinct rather than one command with a flag: `continue` preserves the
// attempt and its context, `rerun` abandons it for a fresh one, and `resume` grants nothing at all (ADR 0041).
const proceed = Command.make("continue", common, (options) => execute({ ...options, command: { type: "continue" } }));
const rerun = Command.make("rerun", { ...common, target: Argument.choice("target", rerunTargets) }, (options) =>
  execute({ ...options, command: { type: "rerun", target: options.target } }),
);
const resume = Command.make("resume", common, (options) => execute({ ...options, command: { type: "resume" } }));

const root = Command.make("sf", {}, () => Console.log("Run `sf --help`.")).pipe(
  Command.withSubcommands([status, cancel, takeover, handoff, proceed, rerun, resume]),
);

function describeFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export const swordfishCli = Command.run(root, { version: "0.0.0" });

if (import.meta.main) {
  swordfishCli.pipe(
    Effect.catch((error) => Console.error(describeFailure(error)).pipe(Effect.andThen(Effect.fail(error)))),
    Effect.provide(SwordfishIdentityLayer),
    Effect.provide(Layer.mergeAll(BunStdio.layer, BunServices.layer)),
    BunRuntime.runMain({ disableErrorReporting: true }),
  );
}
