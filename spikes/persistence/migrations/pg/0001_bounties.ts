// Bebop-authoritative state (SPEC section 22.1), reduced to the smallest shape that still
// exercises the column types Milestone 3 depends on.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE bounties (
      bounty_id  text PRIMARY KEY,
      state      text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // Idempotency keys carry the uniqueness constraint that Milestone 3's "one key cannot
  // create duplicate lifecycle work" exit criterion relies on.
  yield* sql`
    CREATE TABLE idempotency_keys (
      key       text PRIMARY KEY,
      bounty_id text NOT NULL REFERENCES bounties (bounty_id)
    )
  `;
});
