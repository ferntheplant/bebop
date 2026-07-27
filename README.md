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

`ready` builds before it checks and tests, because `@bebop/contracts` resolves through its built `dist`, and
because Vite+ resolves a bare `./dist/*.mjs` command as a binary at _plan_ time — before any task runs. That is
why the executable smoke scripts invoke their artifacts as `sh -c './dist/cli.mjs'` rather than directly:
without it, `vp run ready` cannot plan on a clean checkout where `dist` does not yet exist.

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
