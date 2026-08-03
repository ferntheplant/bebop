#!/usr/bin/env bun

import type { SfControlCommand, SfControlRequest, SfStatusSnapshot } from "@bebop/contracts";
import {
  constraintKeys,
  currentSfControlVersion,
  SfControlRequest as SfControlRequestSchema,
  SfStatusSnapshot as SfStatusSnapshotSchema,
  verificationStages,
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
  // applies was the step `docs/capabilities/05-control-lease-and-takeover.md` asks us to remove.
  if (snapshot.attention !== undefined) {
    const attention = snapshot.attention;
    lines.push(`attention   ${attention.kind}: ${attention.reason}`);
    if (attention.suspendedStage !== undefined) {
      lines.push(`suspended   ${attention.suspendedStage}`);
    }
    lines.push(`resolve     ${attention.resolutions.join(", ")}`);
  }
  for (const seat of snapshot.seats) {
    lines.push(`seat        ${seat.role} ${seat.seatId}${seat.role === snapshot.activeSeat ? " (active)" : ""}`);
  }
  for (const constraint of snapshot.constraints) {
    lines.push(
      `constraint  ${constraint.constraint} ${constraint.consumed}/${constraint.limit} (${constraint.extensionsGranted} extended)`,
    );
  }
  return lines.join("\n");
}

function rejectTrailingArguments(command: SfControlCommand): Effect.Effect<void, Error> {
  const commandName =
    command.type === "approve_config"
      ? "approve-config"
      : command.type === "extend_constraint"
        ? "extend"
        : command.type === "retry_stage"
          ? "retry"
          : command.type;
  const commandIndex = process.argv.indexOf(commandName);
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
  const expected =
    command.type === "takeover" || command.type === "extend_constraint" || command.type === "retry_stage" ? 1 : 0;
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
const stop = Command.make("stop", common, (options) => execute({ ...options, command: { type: "stop" } }));
const handoff = Command.make("handoff", common, (options) => execute({ ...options, command: { type: "handoff" } }));
const approveConfig = Command.make("approve-config", common, (options) =>
  execute({ ...options, command: { type: "approve_config" } }),
);
const takeover = Command.make(
  "takeover",
  {
    ...common,
    seat: Argument.choice("seat", ["ein", "jet", "faye"] as const),
    force: Flag.boolean("force").pipe(Flag.withDescription("Force an interrupted takeover."), Flag.withDefault(false)),
  },
  (options) => execute({ ...options, command: { type: "takeover", seat: options.seat, force: options.force } }),
);
const extend = Command.make(
  "extend",
  { ...common, constraint: Argument.choice("constraint", constraintKeys) },
  (options) => execute({ ...options, command: { type: "extend_constraint", constraint: options.constraint } }),
);
const retry = Command.make("retry", { ...common, stage: Argument.choice("stage", verificationStages) }, (options) =>
  execute({ ...options, command: { type: "retry_stage", stage: options.stage } }),
);

const root = Command.make("sf", {}, () => Console.log("Run `sf --help`.")).pipe(
  Command.withSubcommands([status, stop, takeover, handoff, extend, retry, approveConfig]),
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
