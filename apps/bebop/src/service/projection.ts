// Applying one Swordfish input to the durable projection.
//
// The gateway and the worker both need this, and they must agree: the gateway applies events
// and heartbeats arriving on a socket, the worker applies the freshness expiry that no
// socket will ever announce. Putting the reduce-persist-publish sequence in one place is
// what keeps "the projection changed" and "a client was told" from drifting apart.

import type { BountyId, Timestamp } from "@bebop/contracts";
import { eventFingerprint } from "@bebop/workflow";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql";

import { deriveBountyStatus } from "#src/domain/bounty.ts";
import type {
  BebopProjectionInput,
  BebopProjectionResult,
  BebopSwordfishProjection,
} from "#src/domain/swordfish-projection.ts";
import { reduceBebopSwordfishProjection } from "#src/domain/swordfish-projection.ts";
import { BountyRepository } from "#src/persistence/bounties.ts";
import { BountyEventRepository } from "#src/persistence/events.ts";
import { SwordfishProjectionRepository } from "#src/persistence/swordfish.ts";

export interface AppliedProjection {
  readonly result: BebopProjectionResult;
  readonly projection: BebopSwordfishProjection;
}

/**
 * Reduces one input, persists whatever changed, and publishes what a client can see.
 *
 * Three writes happen in one transaction — the accepted event, the new projection snapshot,
 * and the client-visible events — so a crash cannot leave Bebop having acknowledged an event
 * it did not record, or having recorded state no client will ever hear about.
 *
 * The caller decides what to do with the result. That decision is not cosmetic: an
 * acknowledgement sent for an input Bebop discarded makes Swordfish drop it from its outbox
 * permanently, so `wrong_connection` must never be acknowledged even though it is not an
 * error.
 */
export const applyProjectionInput = Effect.fnUntraced(function* (options: {
  readonly projection: BebopSwordfishProjection;
  readonly input: BebopProjectionInput;
  readonly at: Timestamp;
}) {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* SwordfishProjectionRepository;
  const events = yield* BountyEventRepository;
  const bounties = yield* BountyRepository;

  const before = options.projection;
  const result = reduceBebopSwordfishProjection(before, options.input);
  if (!result.ok) {
    return { result, projection: before } satisfies AppliedProjection;
  }
  if (!result.applied && result.state === before) {
    return { result, projection: before } satisfies AppliedProjection;
  }

  const after = result.state;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (result.applied && options.input.type === "event_received") {
        yield* projections.recordEvent({
          bountyId: after.bountyId,
          message: options.input.message,
          fingerprint: eventFingerprint(options.input.message),
          receivedAt: options.at,
        });
      }
      yield* projections.save({ projection: after, at: options.at });
      yield* publishVisibleChanges({ before, after, input: options.input, at: options.at });
    }),
  );

  return { result, projection: after } satisfies AppliedProjection;

  function publishVisibleChanges(change: {
    readonly before: BebopSwordfishProjection;
    readonly after: BebopSwordfishProjection;
    readonly input: BebopProjectionInput;
    readonly at: Timestamp;
  }) {
    return Effect.gen(function* () {
      const bountyId: BountyId = change.after.bountyId;

      // The Swordfish event itself, exactly once, only when it actually applied.
      if (result.ok && result.applied && change.input.type === "event_received") {
        yield* events.append({
          bountyId,
          occurredAt: change.input.message.occurredAt,
          event: { type: "swordfish_event", event: change.input.message.event },
        });
      }

      if (change.before.freshness.status !== change.after.freshness.status) {
        yield* events.append({
          bountyId,
          occurredAt: change.at,
          event: { type: "swordfish_freshness_changed", freshness: change.after.freshness.status },
        });
      }

      if (change.before.stage !== change.after.stage) {
        const bounty = yield* bounties.get(bountyId);
        if (bounty !== null) {
          const previous = deriveBountyStatus(bounty.lifecycleState, change.before.stage);
          const next = deriveBountyStatus(bounty.lifecycleState, change.after.stage);
          if (previous !== next) {
            yield* events.append({
              bountyId,
              occurredAt: change.at,
              event: { type: "bounty_status_changed", status: next },
            });
          }
        }
      }
    });
  }
});

export type ProjectionServiceRequirements =
  | SqlClient.SqlClient
  | SwordfishProjectionRepository
  | BountyEventRepository
  | BountyRepository;

export type ProjectionServiceFailure = SqlError.SqlError;
