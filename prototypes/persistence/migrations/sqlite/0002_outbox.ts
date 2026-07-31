// The unsent-event outbox (`docs/design/SYSTEM.md` §18.3). Swordfish commits an event here before it
// is externally visible, which is exactly the boundary the SIGKILL probe interrupts.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE bebop_outbox (
      sequence     INTEGER PRIMARY KEY REFERENCES workflow_events (sequence),
      acknowledged INTEGER NOT NULL DEFAULT 0
    )
  `;
});
