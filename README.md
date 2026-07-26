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

Apps may depend on packages, but one app must not import source from another app. Shared code remains with its
first consumer until a second app needs a narrowly named package.

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
