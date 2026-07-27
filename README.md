# Bebop

Bebop is a remote supervised coding-bounty system built around OpenCode and exe.dev. The architecture is
defined in [`SPEC.md`](./SPEC.md), and the implementation sequence is tracked in [`PLAN.md`](./PLAN.md).

## Workspace

| Path                         | Responsibility                                           |
| ---------------------------- | -------------------------------------------------------- |
| `apps/bebop`                 | Bebop API, worker, and thin `bebop` CLI                  |
| `apps/swordfish`             | Swordfish daemon and local `sf` CLI                      |
| `apps/bebop-opencode-plugin` | OpenCode workflow tools and lease enforcement            |
| `packages/contracts`         | Shared schemas and wire contracts                        |
| `packages/testkit`           | Shared test processes, fixtures, and deterministic fakes |
| `spikes/*`                   | Throwaway experiments that validate a design assumption  |

Apps may depend on packages, but one app must not import source from another app. Shared code remains with its
first consumer until a second app needs a narrowly named package.

Spikes are excluded from `vp run test` and are run on demand. Each spike records its verdict in its own
`README.md`, and any assumption it invalidates is reflected in [`SPEC.md`](./SPEC.md) before implementation
continues.

## Development

Vite+ manages the configured runtime, Bun package manager, checks, tests, builds, and workspace tasks.

Install dependencies:

```bash
vp install
```

Run the complete local readiness check:

```bash
vp run ready
```

Tasks declare their own prerequisites with Vite+ `dependsOn` in `vite.config.ts` rather than being chained with
shell `&&`, so every task is correct when run on its own from a clean checkout — `vp run smoke` builds what it
needs before it runs. `ready` is an aggregator whose gate is its dependencies.

Two constraints shaped that wiring:

- `check` and the test tasks resolve `@bebop/contracts` through its built `dist`, so they depend on `build`;
- Vite+ resolves a bare `./dist/*.mjs` command as a binary at _plan_ time, before any task runs, so the
  executable smoke tasks invoke their artifacts as `sh -c './dist/cli.mjs'`. Without that, planning fails on a
  clean checkout where `dist` does not exist yet, no matter how the dependencies are declared.

Run individual checks:

```bash
vp check
vp test --run
vp run build
```

Start the Bebop API scaffold:

```bash
vp run dev
```

All commits must follow Conventional Commits. Vite+ installs the pre-commit and commit-message hooks through the
root `prepare` script.
