# Refuse rather than pretend

Where an external authority a route depends on does not exist yet, the route refuses. `merge` returns a refusal rather than a success, because merge authority needs GitHub and answering anything else would claim a side effect that never happened; the evidence route reports an empty bundle list for the same reason.

A stub that returns a plausible success is indistinguishable from working software right up until it matters, and every caller written against it encodes the lie.

## Consequences

This extends to the fake lifecycle provider used before exe.dev exists: it creates deterministic local VM records and is honest about being local, rather than imitating a provisioned computer.
