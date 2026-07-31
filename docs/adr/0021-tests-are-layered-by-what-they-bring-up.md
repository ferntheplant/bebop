# Tests are layered by what they bring up, and unit tests are colocated

Tests are layered by what they start, not by where they live: unit tests stub nothing and sit beside their source as `src/<area>/<area>.test.ts`; component tests boot the real production layer stack and live in `apps/<app>/test/component/`; integration tests spawn real child processes from `test/integration/`; artifact smokes run the packed `dist/*.mjs`. See [`docs/testing.md`](../testing.md) for the full table and conventions.

A unit test constrains one source file, so colocating them keeps deletions and renames commuting naturally. A component test constrains how an app's layers _compose_, which belongs to no single file — putting it beside one of them would misrepresent what it covers.

## Consequences

Component tests stub exactly two layers, `Identity` and `LifecycleProvider`, and run against a real disposable Postgres. Everything else is the production stack, because the behaviour they cover — transactional idempotency, `FOR UPDATE SKIP LOCKED`, advisory locks, `jsonb` and `bigint` encodings — is precisely what a fake would paper over.

Colocated test files do not ship in bundled artifacts: `vp pack` traces only from explicit `pack.entry` inputs.
