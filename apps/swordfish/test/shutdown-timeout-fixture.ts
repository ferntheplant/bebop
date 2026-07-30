import { createServer } from "node:net";

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Duration, Effect, Exit, Scope } from "effect";

import { closeScopeWithin } from "#src/daemon.ts";

const program = Effect.gen(function* () {
  const server = createServer();
  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
  });
  const scope = yield* Scope.make();
  yield* Scope.addFinalizer(scope, Effect.never);
  yield* closeScopeWithin(scope, Exit.void, Duration.millis(50));
});

BunRuntime.runMain(program);
