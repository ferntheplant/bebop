// Applying one Swordfish input to the durable projection.
//
// The gateway and the worker both need this, and they must agree: the gateway applies events
// and heartbeats arriving on a socket, the worker applies the freshness expiry that no
// socket will ever announce. Putting the reduce-persist-publish sequence in one place is
// what keeps "the projection changed" and "a client was told" from drifting apart.

import type { BountyId, Timestamp, VmId } from "@bebop/contracts";
import { eventFingerprint } from "@bebop/workflow";
import { Effect } from "effect";
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

interface AppliedProjection {
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
  readonly bountyId: BountyId;
  readonly vmId: VmId;
  readonly input: BebopProjectionInput;
  readonly at: Timestamp;
}) {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* SwordfishProjectionRepository;
  const events = yield* BountyEventRepository;
  const bounties = yield* BountyRepository;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // The projection is a single aggregate. Lock before loading it so every reducer input
      // observes the result of the previous one, including when the row does not exist yet.
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${options.bountyId})::bigint)`;
      const before = yield* projections.load({ bountyId: options.bountyId, vmId: options.vmId });
      if (before.vmId !== options.vmId) {
        return {
          result: {
            ok: false,
            error: {
              type: "identity_mismatch",
              expectedBountyId: before.bountyId,
              expectedVmId: before.vmId,
            },
          },
          projection: before,
        } satisfies AppliedProjection;
      }
      const result = reduceBebopSwordfishProjection(before, options.input);
      if (!result.ok) {
        return { result, projection: before } satisfies AppliedProjection;
      }
      if (!result.applied && result.state === before) {
        return { result, projection: before } satisfies AppliedProjection;
      }

      const after = result.state;
      if (result.applied && options.input.type === "event_received") {
        yield* projections.recordEvent({
          bountyId: after.bountyId,
          message: options.input.message,
          fingerprint: eventFingerprint(options.input.message),
          receivedAt: options.at,
        });
      }
      yield* projections.save({ projection: after, at: options.at });
      yield* publishVisibleChanges({ before, after, input: options.input, result, at: options.at });
      return { result, projection: after } satisfies AppliedProjection;
    }),
  );

  function publishVisibleChanges(change: {
    readonly before: BebopSwordfishProjection;
    readonly after: BebopSwordfishProjection;
    readonly input: BebopProjectionInput;
    readonly result: BebopProjectionResult;
    readonly at: Timestamp;
  }) {
    return Effect.gen(function* () {
      const bountyId: BountyId = change.after.bountyId;

      // The Swordfish event itself, exactly once, only when it actually applied.
      if (change.result.ok && change.result.applied && change.input.type === "event_received") {
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

      // Controller is part of the derived status ("One controller drives one active cowboy" (ADR 0037)), so a
      // takeover that changes nothing else still changes what clients see. Omitting it here would leave a
      // taken-over bounty reporting `autonomous` on the event stream until some unrelated stage change happened
      // to republish it.
      if (
        change.before.stage !== change.after.stage ||
        change.before.controller !== change.after.controller ||
        change.before.freshness.status !== change.after.freshness.status
      ) {
        const bounty = yield* bounties.get(bountyId);
        if (bounty !== null) {
          const previous = deriveBountyStatus(
            bounty.lifecycleState,
            change.before.stage,
            change.before.controller,
            change.before.freshness.status,
          );
          const next = deriveBountyStatus(
            bounty.lifecycleState,
            change.after.stage,
            change.after.controller,
            change.after.freshness.status,
          );
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
