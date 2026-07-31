// A stand-in for the `bebop` and `sf` executables, used to check that
// `effect/unstable/cli` parses arguments and sets process exit codes under Bun.
//
// Exit codes are the whole point: Milestone 4 requires that "`sf` cannot operate when
// the daemon is absent, the socket permissions are unsafe, or the response fails schema
// validation", and a CLI that reports failure with status 0 cannot express that.

import { BunRuntime, BunServices, BunStdio } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";

const status = Command.make(
  "status",
  { bounty: Flag.string("bounty"), verbose: Flag.boolean("verbose") },
  ({ bounty, verbose }) => Console.log(`status bounty=${bounty} verbose=${verbose}`),
);

const fail = Command.make("fail", {}, () => Effect.fail(new Error("the daemon is not running")));

const root = Command.make("spike-cli", {}, () => Console.log("spike-cli")).pipe(
  Command.withSubcommands([status, fail]),
);

// `Command.run` reads argv from the `Stdio` service rather than `process.argv`, so the CLI
// needs a platform layer supplying it. `BunRuntime.runMain` does not provide one.
Command.run(root, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(BunStdio.layer, BunServices.layer)),
  BunRuntime.runMain,
);
