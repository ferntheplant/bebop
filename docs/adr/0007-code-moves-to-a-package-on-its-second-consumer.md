# Code moves to a package on its second consumer

`apps/*` own deployable programs and must not import source from one another; `packages/*` hold what two or more
apps need. Code stays with its first consumer and moves into a narrowly named package only when a second app
needs it — there is no `utils` package, and there never will be.

The rule is stated in terms of _meaning_ rather than types because `packages/contracts` was not enough on its
own: bebop and Swordfish shared the wire types but had each independently written down what those types meant,
and the two copies had already drifted in two user-visible ways. `packages/workflow` is what the rule looks like
when it fires.
