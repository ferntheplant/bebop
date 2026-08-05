import type { CorrelationId, Timestamp } from "@bebop/contracts";
import { CorrelationId as CorrelationIdSchema, Timestamp as TimestampSchema } from "@bebop/contracts";
import { Context, Effect, Layer, Schema } from "effect";

interface SwordfishIdentityService {
  readonly correlationId: Effect.Effect<CorrelationId>;
  readonly now: Effect.Effect<Timestamp>;
}

export class SwordfishIdentity extends Context.Service<SwordfishIdentity, SwordfishIdentityService>()(
  "SwordfishIdentity",
) {}

function timestampAt(millis: number): Timestamp {
  return Schema.decodeUnknownSync(TimestampSchema)(new Date(millis).toISOString());
}

export function timestampToIso(timestamp: Timestamp): string {
  return Schema.encodeSync(TimestampSchema)(timestamp);
}

export const SwordfishIdentityLayer: Layer.Layer<SwordfishIdentity> = Layer.sync(SwordfishIdentity)(() => ({
  correlationId: Effect.sync(() =>
    Schema.decodeUnknownSync(CorrelationIdSchema)(`sf-${crypto.randomUUID().replaceAll("-", "")}`),
  ),
  now: Effect.sync(() => timestampAt(Date.now())),
}));

export function fixedSwordfishIdentityLayer(options?: {
  readonly startAt?: string;
  readonly stepMillis?: number;
}): Layer.Layer<SwordfishIdentity> {
  return Layer.sync(SwordfishIdentity)(() => {
    let clock = new Date(options?.startAt ?? "2026-07-29T00:00:00.000Z").getTime();
    let correlation = 0;
    return {
      correlationId: Effect.sync(() => {
        correlation += 1;
        return Schema.decodeUnknownSync(CorrelationIdSchema)(`sf-${String(correlation).padStart(6, "0")}`);
      }),
      now: Effect.sync(() => {
        const current = clock;
        clock += options?.stepMillis ?? 1_000;
        return timestampAt(current);
      }),
    };
  });
}
