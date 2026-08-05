import { Context, Deferred, Effect, Layer } from "effect";

interface ShutdownSignalService {
  readonly await: Effect.Effect<void>;
  readonly request: Effect.Effect<void>;
}

export class ShutdownSignal extends Context.Service<ShutdownSignal, ShutdownSignalService>()("ShutdownSignal") {}

export const ShutdownSignalLayer: Layer.Layer<ShutdownSignal> = Layer.effect(
  ShutdownSignal,
  Effect.gen(function* () {
    const signal = yield* Deferred.make<void>();
    return {
      await: Deferred.await(signal),
      request: Deferred.succeed(signal, undefined).pipe(Effect.asVoid),
    };
  }),
);
