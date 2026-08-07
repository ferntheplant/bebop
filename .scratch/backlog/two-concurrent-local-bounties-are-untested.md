# Nothing proves two local bounties actually run side by side

"Two local bounties run concurrently without colliding on socket, database, or working-copy paths" is a claim
the README makes and `localBountyPaths` looks structurally correct about — every path derives from
`bounties/<bountyId>/`. But no test runs two. `component/local-daemon.test.ts` and `test/local-system/` both
drive exactly one bounty, so the property is argued from the shape of the code rather than observed.

The cheap half is a component-level assertion that two specs produce disjoint path sets. The half that would
actually catch something is two real daemons up at once in `test/local-system/`, each answering its own control
socket with its own stage — that is where a collision would surface as one daemon refusing its SQLite authority
lock, and where a shared-root mistake would be visible rather than inferred.

Weigh the runtime cost first: the local-system suite already runs two packed bebop processes and a daemon per
test, and a second concurrent bounty is a second clone.

Noticed while reviewing the change that made the local provider start the daemon.
