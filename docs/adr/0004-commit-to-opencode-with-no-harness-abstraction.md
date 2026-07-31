# Commit to OpenCode with no harness abstraction

Swordfish binds directly to OpenCode's server API, SDK types, and SSE event stream, and the bebop plugin is a first-class module of the product. There is no harness-neutral interface behind which a second agent harness could be substituted.

One adapter means a hypothetical seam; two adapters means a real one. There is exactly one harness, so a harness abstraction would be a shallow module — a large interface with a thin implementation — that costs vocabulary and depth on every call site while varying nothing. OpenCode's server API and web UI are also the intended path to a richer cockpit later, which a lowest-common-denominator interface would have to hide.

## Consequences

If the harness ever changes, rewriting Swordfish's integration layer is the accepted cost. The pinned OpenCode version is part of the base image and upgrades are qualified by a smoke bounty.
