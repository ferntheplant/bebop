// Bebop's projection of the Swordfish event stream (`docs/design/SYSTEM.md` §§18.3 and 22.1).
//
// `sequence` is bigint on purpose: protocol sequence numbers are the one place where a
// driver that silently narrows integers to JavaScript doubles would corrupt state, so the
// spike wants the widest realistic column.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE swordfish_events (
      bounty_id text   NOT NULL REFERENCES bounties (bounty_id),
      sequence  bigint NOT NULL,
      payload   jsonb  NOT NULL,
      PRIMARY KEY (bounty_id, sequence)
    )
  `;
});
