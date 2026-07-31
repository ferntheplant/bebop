// Swordfish-authoritative state (`docs/design/SYSTEM.md` §22.2). The durable event log Swordfish
// replays from on restart.

import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE workflow_events (
      sequence     INTEGER PRIMARY KEY,
      stage        TEXT NOT NULL,
      payload      TEXT NOT NULL,
      committed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;
});
