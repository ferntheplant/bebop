# Tasks declare their own prerequisites instead of chaining with `&&`

Every Vite+ task in `vite.config.ts` declares what it needs with `dependsOn`, so any task run alone on a clean
checkout builds its prerequisites first. `ready` is an aggregator whose gate is its dependency set, not a shell
chain.

This was learned the hard way: Milestone 1 was marked complete against the exit criterion "a clean clone can run
`vp install --frozen-lockfile` and `vp run ready`" when `ready` in fact only passed on a machine that already had
`dist` from an earlier build, and CI had been failing on `main` for that reason.

## Consequences

Two Vite+ ordering faults have to be designed around, and both look like tidiness opportunities to someone who
did not hit them — see [Build and packaging](../gotchas.md#build-and-packaging).
