// Bounding how long shutdown may take.
//
// Bun's `server.stop()` is a *graceful* stop: it waits for open connections to finish. That
// is what `docs/design/SYSTEM.md` §24's blue/green deployment wants — "flip upstream → drain old" — right
// up until a connection never finishes, at which point the old colour never exits and the
// deploy never completes.
//
// This is not hypothetical. A WebSocket whose close handshake is still in flight when the
// server stops accepting will hold a graceful stop open indefinitely, which is exactly the
// state a Swordfish reconnect leaves behind.
//
// `shutdownTimeout` is the answer the configuration already promised: drain for that long,
// then stop waiting and let the process go.

import { Duration, Effect, Exit, Layer, Scope } from "effect";

/**
 * Runs a layer's finalizers with a deadline.
 *
 * Past the deadline the finalizers are abandoned rather than awaited. That is safe here
 * because everything durable was committed to Postgres long before shutdown began; what is
 * being abandoned is a socket the operating system will reclaim when the process exits.
 */
export function withBoundedShutdown<A, E, R>(
  self: Layer.Layer<A, E, R>,
  limit: Duration.Duration,
): Layer.Layer<A, E, R> {
  return Layer.effectContext(
    Effect.gen(function* () {
      const inner = yield* Scope.make();
      const context = yield* Layer.buildWithScope(self, inner);
      yield* Effect.addFinalizer(() =>
        Scope.close(inner, Exit.void).pipe(
          Effect.timeoutOption(limit),
          Effect.flatMap((closed) =>
            closed._tag === "Some"
              ? Effect.void
              : Effect.logWarning("shutdown deadline passed with connections still draining").pipe(
                  Effect.annotateLogs("shutdown_timeout_ms", String(Duration.toMillis(limit))),
                ),
          ),
        ),
      );
      return context;
    }),
  );
}
