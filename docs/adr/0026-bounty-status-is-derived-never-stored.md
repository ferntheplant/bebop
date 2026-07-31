# The compact bounty status is derived, never stored

`bounty list` and `bounty status` compute their compact status from the projection on read. It is never written to a column.

A stored status would have to be rewritten on every projection update, and the first update that forgot would leave `bounty list` disagreeing with `bounty status` permanently — a disagreement no test would catch, because both would be internally consistent.

## Consequences

The same instinct applies to the surrounding code: state that can be derived from the event stream is derived, and the stream stays the single authority.
