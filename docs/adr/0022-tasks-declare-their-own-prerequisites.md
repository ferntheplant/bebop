# Tasks declare their own prerequisites instead of chaining with `&&`

Every Vite+ task in `vite.config.ts` declares what it needs with `dependsOn`, so any task run alone on a clean checkout builds its prerequisites first. `ready` is an aggregator whose gate is its dependency set, not a shell chain.

This was learned the hard way: Milestone 1 was marked complete against the exit criterion "a clean clone can run `vp install --frozen-lockfile` and `vp run ready`" when `ready` in fact only passed on a machine that already had `dist` from an earlier build, and CI had been failing on `main` for that reason.

## Consequences

Two ordering faults are permanently designed around, and both look like tidiness opportunities to someone who did not hit them:

- `check` and the test tasks resolve `@bebop/contracts` through its built `dist`, so they depend on `build`.
- Vite+ resolves a bare `./dist/*.mjs` command as a binary at **plan** time, before any task runs, so no task may name a built artifact directly. The artifact smokes go through `apps/bebop/scripts/smoke.ts` instead — which also lets them assert something worth asserting: that each packed bundle loads and reaches its own code, proved by the servers reporting a configuration error and the CLI printing its usage. A missing dependency or a dynamic import that did not survive bundling fails there, and none of that is visible from a type check.
