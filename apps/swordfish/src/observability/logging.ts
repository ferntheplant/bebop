import type { Layer } from "effect";
import { Effect, Logger } from "effect";

export const structuredLoggingLayer: Layer.Layer<never> = Logger.layer([Logger.consoleJson]);

export function withSwordfishComponent<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.annotateLogs(effect, "component", "swordfish");
}
