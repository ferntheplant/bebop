# Vitest is launched by Bun, not by the Node runtime Vite+ manages

The `test`, `test:integration`, and `test:e2e` tasks run `bun node_modules/vitest/vitest.mjs` rather than `vp test`. Vite+ manages a Node runtime and launches Vitest with it, which would put every test on a runtime the code under test never runs on — the API serves on `BunHttpServer`, which a Node-hosted worker cannot start at all.

Launched by Bun, Vitest's workers are Bun workers: `Bun` globals resolve, `BunHttpServer` starts, and one runner covers unit, component, integration, and process-level tests. The value is not consistency for its own sake — it is that no test can pass on a runtime production never uses.

## Consequences

`vitest` is a direct devDependency pinned in the catalog to the version Vite+ vendors, and the two must be upgraded together. That coupling is the one way this arrangement can drift.

`vp test` still works for an ad-hoc run of the pure tests and forwards options to Vitest as usual; it runs on Node, so it cannot start the component suites.
