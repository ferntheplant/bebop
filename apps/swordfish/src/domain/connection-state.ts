// The live Bebop connection, as the reconnect loop knows it.
//
// This is deliberately not a column. `sf status` reports how long a daemon has been
// disconnected and when it retries next, and both are facts only the reconnect loop holds —
// writing them to SQLite would be the second copy this repo's architectural rules forbid
// ("The state is derived from the live connection rather than stored"). The loop is the only
// writer; the control server reads through the same in-process service, so the snapshot is
// the live connection rather than a stored image of it.
//
// `never_connected` is the state before the first successful registration, and it persists
// through every retry that fails before one: a daemon started with Bebop down has connected
// to nothing yet, which is a different claim than having connected and lost it.
// `disconnected` records when the connection was lost and when the next attempt is due; both
// timestamps let a reader derive the duration on read.

import type { Timestamp } from "@bebop/contracts";
import { Context, Effect, Layer, Ref } from "effect";

import { SwordfishIdentity } from "#src/domain/identity.ts";

export type BebopConnectionLiveState =
  | { readonly kind: "never_connected"; readonly since: Timestamp }
  | { readonly kind: "connected"; readonly connectedAt: Timestamp }
  | { readonly kind: "disconnected"; readonly disconnectedSince: Timestamp; readonly nextAttemptAt: Timestamp };

interface BebopConnectionStateService {
  readonly current: Effect.Effect<BebopConnectionLiveState>;
  readonly markConnected: (connectedAt: Timestamp) => Effect.Effect<void>;
  readonly markDisconnected: (disconnectedSince: Timestamp, nextAttemptAt: Timestamp) => Effect.Effect<void>;
  readonly markNeverConnected: (since: Timestamp) => Effect.Effect<void>;
}

export class BebopConnectionState extends Context.Service<BebopConnectionState, BebopConnectionStateService>()(
  "BebopConnectionState",
) {}

export const BebopConnectionStateLayer: Layer.Layer<BebopConnectionState, never, SwordfishIdentity> = Layer.effect(
  BebopConnectionState,
)(
  Effect.gen(function* () {
    const identity = yield* SwordfishIdentity;
    const started = yield* identity.now;
    const ref = yield* Ref.make<BebopConnectionLiveState>({ kind: "never_connected", since: started });
    return {
      current: Ref.get(ref),
      markConnected: (connectedAt) => Ref.set(ref, { kind: "connected", connectedAt }),
      markDisconnected: (disconnectedSince, nextAttemptAt) =>
        Ref.set(ref, { kind: "disconnected", disconnectedSince, nextAttemptAt }),
      markNeverConnected: (since) => Ref.set(ref, { kind: "never_connected", since }),
    };
  }),
);
