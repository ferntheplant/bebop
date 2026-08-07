// The live Bebop connection, as the reconnect loop knows it.
//
// This is deliberately not a column. `sf status` reports how long a daemon has been disconnected
// and when it retries next, and both are facts only the reconnect loop holds — writing them to
// SQLite would be the second copy the architectural rule forbids: state derivable from the event
// stream is derived on read, never stored. The loop is the only writer; the control server reads
// through the same in-process service, so the snapshot is the live connection rather than a stored
// image of it. Reporting it at all is the Swordfish side of the freshness obligation in "Bebop owns
// authority, Swordfish owns the loop" (ADR 0002): a loop that keeps running while Bebop is
// unreachable has to say so, or it is indistinguishable from a stuck one.
//
// `never_connected` is the state before the first successful registration, and it persists through
// every retry that fails before one: a daemon started with Bebop down has connected to nothing yet,
// which is a different claim than having connected and lost it. `disconnected` records when the
// connection was lost and when the next attempt is due; both timestamps let a reader derive the
// duration on read.
//
// The transitions and the backoff arithmetic below are pure, so they are tested without a socket.
// The service is the only stateful part, and it holds exactly one `Ref`.

import type { SfBebopConnectionSnapshot, Timestamp } from "@bebop/contracts";
import { Context, Effect, Layer, Ref } from "effect";

import { SwordfishIdentity, timestampToIso } from "#src/domain/identity.ts";

export type BebopConnectionLiveState =
  | { readonly kind: "never_connected"; readonly since: Timestamp }
  | { readonly kind: "connected"; readonly connectedAt: Timestamp }
  | { readonly kind: "disconnected"; readonly disconnectedSince: Timestamp; readonly nextAttemptAt: Timestamp };

/**
 * The reconnect loop's wait schedule: fixed bounds plus the exponential ceiling that grows within
 * them. Kept together because a wait is only meaningful against the bounds it was drawn from.
 */
export interface ReconnectBackoff {
  readonly minimumMillis: number;
  readonly maximumMillis: number;
  readonly ceilingMillis: number;
}

/** The schedule a daemon starts on, and the one it returns to when a registration lands. */
export function initialBackoff(minimumMillis: number, maximumMillis: number): ReconnectBackoff {
  return { minimumMillis, maximumMillis, ceilingMillis: minimumMillis };
}

/**
 * Bounded exponential backoff with full jitter. The ceiling doubles toward the maximum, and the
 * wait is drawn uniformly within `[minimum, ceiling]` from `jitter` — a fraction in `[0, 1)`, which
 * the caller takes from the `Random` service so tests can seed it — so a fleet of daemons retrying
 * one outage does not thump back in lockstep.
 */
export function nextBackoff(
  backoff: ReconnectBackoff,
  jitter: number,
): { readonly waitMillis: number; readonly backoff: ReconnectBackoff } {
  const ceilingMillis = Math.min(backoff.maximumMillis, backoff.ceilingMillis * 2);
  const span = Math.max(0, ceilingMillis - backoff.minimumMillis);
  return {
    waitMillis: backoff.minimumMillis + jitter * span,
    backoff: { ...backoff, ceilingMillis },
  };
}

/**
 * Where a failed connection attempt leaves the reported state.
 *
 * The distinction that makes `sf status` honest lives here. A daemon that has never registered has
 * connected to nothing, so a failed attempt leaves it never-connected since it started trying, not
 * freshly disconnected. And an outage began when the connection ended, not when the latest retry
 * failed — only `nextAttemptAt` moves while it holds, or a half-hour outage would report itself as
 * two seconds old.
 */
export function afterConnectionLoss(
  current: BebopConnectionLiveState,
  lostAt: Timestamp,
  nextAttemptAt: Timestamp,
): BebopConnectionLiveState {
  if (current.kind === "never_connected") return current;
  const disconnectedSince = current.kind === "disconnected" ? current.disconnectedSince : lostAt;
  return { kind: "disconnected", disconnectedSince, nextAttemptAt };
}

/**
 * The live connection as the control protocol carries it, encoded beside the delivery counters it
 * is reported with. It lives here rather than in the store because the three states are this
 * module's shape, and the store would otherwise re-derive them from a kind it does not own.
 */
export function encodeBebopConnection(options: {
  readonly connection: BebopConnectionLiveState;
  readonly lastContactAt: string | undefined;
  readonly acknowledgedThrough: number;
  readonly pendingEventCount: number;
}): typeof SfBebopConnectionSnapshot.Encoded {
  const { connection, lastContactAt, acknowledgedThrough, pendingEventCount } = options;
  const delivery = { acknowledgedThrough, pendingEventCount };
  // A daemon that has never reached Bebop has no last contact to report, so that state carries no
  // slot for one and nothing here has to decide whether a stale value belongs in it.
  if (connection.kind === "never_connected") {
    return { state: "never_connected", neverConnectedSince: timestampToIso(connection.since), ...delivery };
  }
  const contact = lastContactAt === undefined ? {} : { lastContactAt };
  if (connection.kind === "connected") {
    return { state: "connected", connectedAt: timestampToIso(connection.connectedAt), ...contact, ...delivery };
  }
  return {
    state: "disconnected",
    disconnectedSince: timestampToIso(connection.disconnectedSince),
    nextAttemptAt: timestampToIso(connection.nextAttemptAt),
    ...contact,
    ...delivery,
  };
}

interface BebopConnectionStateService {
  readonly current: Effect.Effect<BebopConnectionLiveState>;
  readonly markConnected: (connectedAt: Timestamp) => Effect.Effect<void>;
  readonly markLost: (lostAt: Timestamp, nextAttemptAt: Timestamp) => Effect.Effect<void>;
}

export class BebopConnectionState extends Context.Service<BebopConnectionState, BebopConnectionStateService>()(
  "BebopConnectionState",
) {}

export const BebopConnectionStateLayer: Layer.Layer<BebopConnectionState, never, SwordfishIdentity> = Layer.effect(
  BebopConnectionState,
)(
  Effect.gen(function* () {
    const identity = yield* SwordfishIdentity;
    // Building the layer is the one place `never_connected` is written: a process life begins
    // having reached nobody, and every later transition is a reaction to the socket.
    const started = yield* identity.now;
    const ref = yield* Ref.make<BebopConnectionLiveState>({ kind: "never_connected", since: started });
    return {
      current: Ref.get(ref),
      markConnected: (connectedAt) => Ref.set(ref, { kind: "connected", connectedAt }),
      markLost: (lostAt, nextAttemptAt) =>
        Ref.update(ref, (current) => afterConnectionLoss(current, lostAt, nextAttemptAt)),
    };
  }),
);
