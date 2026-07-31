# Code moves to a package on its second consumer

`apps/*` own deployable programs and must not import source from one another; `packages/*` hold what two or more apps need. Code stays with its first consumer and moves into a narrowly named package only when a second app needs it — there is no `utils` package, and there never will be.

## Consequences

`packages/workflow` is what the rule looks like when it fires, and why it is stated in terms of _meaning_ rather than types. Sharing the wire types through `packages/contracts` was not enough: bebop and Swordfish had each independently written down what those types mean, and the two copies had already drifted in two user-visible ways. The pure transition core is now one module — Swordfish's reducer is that core plus a non-null starting stage, and bebop's projection is that core plus connection identity and freshness.
