// Cursor replay followed by live delivery, with no history/live race.
//
// PLAN Milestone 3's exit criterion is "SSE replay delivers each stored event once in
// sequence before switching to live delivery". The property is structural here rather than
// tested-into-existence:
//
// - there is exactly one source of truth for what a client has seen — a cursor that starts
//   at `Last-Event-ID` and advances only as events are emitted;
// - both phases read the same table through the same paged query, so replay and live are the
//   same operation with a different trigger;
// - the live phase is *triggered* by a Postgres notification or a timer, but the events it
//   emits always come from a read after the current cursor. A notification that arrives
//   early, twice, or not at all cannot produce a duplicate, a gap, or an out-of-order event.
//
// `spikes/effect-runtime` (S1–S3) proved the transport half of this on the pinned Bun; what
// it did not cover — a live subscription rather than a finite range — is what this module is.

import type { BountyEventCursorString, BountyEventEnvelope, BountyId } from "@bebop/contracts";
import { BountyEventCursorString as BountyEventCursorStringSchema } from "@bebop/contracts";
import { Effect, Option, Ref, Schema, Stream } from "effect";
import type { SqlError } from "effect/unstable/sql";

import { BebopConfiguration } from "#src/config.ts";
import { BountyEventRepository } from "#src/persistence/events.ts";

/** How many stored events one read returns. Replay pages until the log is exhausted. */
const pageSize = 200;

export interface SseFrame {
  readonly id: BountyEventCursorString;
  readonly event: "bounty_event";
  readonly data: BountyEventEnvelope;
}

const decodeCursorString = Schema.decodeUnknownSync(BountyEventCursorStringSchema);

function toFrame(envelope: BountyEventEnvelope): SseFrame {
  // The contract checks that the SSE id equals the cursor. Deriving one from the other,
  // rather than accepting both from a caller, is what makes that check unfailable here.
  return { id: decodeCursorString(String(envelope.cursor)), event: "bounty_event", data: envelope };
}

/**
 * The event stream for one bounty, from `afterCursor` onward, forever.
 *
 * The returned stream never completes on its own: SSE clients stay attached, and the
 * connection ends when the client disconnects or the server shuts down.
 */
export const bountyEventStream = Effect.fnUntraced(function* (options: {
  readonly bountyId: BountyId;
  readonly afterCursor: number;
}) {
  const config = yield* BebopConfiguration;
  const events = yield* BountyEventRepository;

  const cursor = yield* Ref.make(options.afterCursor);

  /** Reads and emits pages after the cursor, advancing only one emitted page at a time. */
  const drain: Stream.Stream<BountyEventEnvelope, SqlError.SqlError> = Stream.paginate(undefined, () =>
    Effect.gen(function* () {
      const after = yield* Ref.get(cursor);
      const page = yield* events.read({ bountyId: options.bountyId, afterCursor: after, limit: pageSize });
      if (page.length === 0) {
        return [[], Option.none()] as const;
      }
      const last = page.at(-1);
      if (last !== undefined) {
        yield* Ref.set(cursor, last.cursor);
      }
      return [page, page.length === pageSize ? Option.some(undefined) : Option.none()] as const;
    }),
  );

  // A notification wakes the reader immediately; the tick is the floor that keeps delivery
  // correct if a notification is lost, if the listening connection drops, or if the event
  // was written by a process whose notify never reached this one.
  const notifications: Stream.Stream<void> = events.appended.pipe(
    Stream.filter((bountyId) => bountyId === options.bountyId),
    Stream.map(() => undefined),
    // A failed LISTEN degrades this stream to polling rather than ending the client's
    // subscription: added latency is a better answer than a dropped connection.
    Stream.catchCause(() => Stream.empty),
  );

  const wakeups = Stream.merge(notifications, Stream.tick(config.eventStreamPollInterval));

  const live = wakeups.pipe(Stream.flatMap(() => drain));

  // Concatenation, not merge: the live phase is not subscribed to until replay has finished
  // emitting, so a live event cannot overtake a replayed one.
  return Stream.concat(drain, live).pipe(Stream.map(toFrame));
});
