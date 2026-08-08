# Bebop

Bebop is a remote supervised coding-bounty system built around OpenCode and exe.dev. What it is and why it
exists is in [`ABSTRACT.md`](./ABSTRACT.md); the vocabulary is in [`CONTEXT.md`](./CONTEXT.md); the decisions
are in [`docs/adr/`](./docs/adr/); and what each capability delivers is in
[`docs/capabilities/`](./docs/capabilities/). [`AGENTS.md`](./AGENTS.md) is the working map of all of it.

## Workspace

| Path                         | Responsibility                                           |
| ---------------------------- | -------------------------------------------------------- |
| `apps/bebop`                 | Bebop API, worker, and thin `bebop` CLI                  |
| `apps/swordfish`             | Swordfish daemon and local `sf` CLI                      |
| `apps/bebop-opencode-plugin` | OpenCode workflow tools and lease enforcement            |
| `packages/contracts`         | Shared schemas and wire contracts                        |
| `packages/workflow`          | The pure Swordfish workflow transition core              |
| `packages/testkit`           | Shared test processes, fixtures, and deterministic fakes |
| `prototypes/*`               | Throwaway experiments that validate a design assumption  |

Apps may depend on packages, but one app must not import source from another app. Shared code remains with its
first consumer until a second app needs a narrowly named package.

Prototypes are excluded from `vp run test` and are run on demand. Each one records its verdict in its own
`README.md`, and any assumption it invalidates is reflected in [`docs/adr/`](./docs/adr/) before implementation
continues.

| Prototype                                  | Proves                                                        | Needs                     |
| ------------------------------------------ | ------------------------------------------------------------- | ------------------------- |
| `prototypes/cockpit`                       | Managed seat windows preserve operator-shaped tmux layout     | a running Docker daemon   |
| `prototypes/effect-runtime`                | Effect HTTP, SSE, WebSocket, and CLI run as processes on Bun  | nothing beyond loopback   |
| `prototypes/lease-guard`                   | The OpenCode plugin can refuse prompts on a leased seat       | `opencode` 1.18.5 on PATH |
| `prototypes/opencode-seat-mutation-events` | Unmatched shell, abort, revert, and unrevert are observable   | network on first run      |
| `prototypes/persistence`                   | Effect round-trips durable state through Postgres and SQLite  | a running Docker daemon   |
| `prototypes/real-process-local-protocol`   | Packed Bebop and Swordfish reconnect and replay over loopback | a running Docker daemon   |
| `prototypes/tmux-input-lock`               | tmux locks input to one pane without hiding its output        | `tmux` on PATH            |

```bash
vp run @bebop/prototype-persistence#prototype
```

Each exits nonzero if any probe fails, and tears down its own state before it starts as well as after, so an
interrupted run cannot leave a container, socket, or database behind for the next run to inherit.

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

Run the maintained local system harness — packed Bebop API, worker, CLI, Swordfish daemon, and `sf` CLI over
loopback against disposable Postgres, proving the packed-process protocol floor
(see [`docs/testing.md`](./docs/testing.md)):

```bash
docker compose up -d --wait postgres
export BEBOP_TEST_DATABASE_URL=postgres://bebop:bebop@127.0.0.1:5433/bebop
vp run local-system
```

To run a whole bounty by hand rather than under the harness, see
[Run one bounty end to end, locally](#run-one-bounty-end-to-end-locally) below — creating a bounty is what starts
its Swordfish daemon, in that mode and in this suite alike. The processes below can also each be run on their
own. What the local mode assembles, and why bebop stays in it where it protects nothing, is
[The local loop runs the production assembly (ADR 0046)](./docs/adr/0046-the-local-loop-runs-the-production-assembly.md).

### Worktrees: one Postgres container, one database per checkout

Every checkout on the machine shares a single Postgres container. `compose.yml` pins its project name to
`bebop`, so `docker compose up` from any checkout attaches to the same container instead of starting a second
one that fights over port 5433. Each checkout gets its own database on that container, named after its
directory — the main checkout uses the seeded `bebop` database, a worktree uses `bebop_<sanitized basename>`.
Tests need no per-checkout database at all: every suite creates and drops its own randomly named one through
`BEBOP_TEST_DATABASE_URL`, so they already cannot collide.

The URLs are recorded in the gitignored `mise.local.toml`, which [mise](https://mise.jdx.dev) loads into the
shell. They live in real process environment rather than a file a child loads on its own because the `test` and
`local-system` tasks fingerprint `BEBOP_TEST_DATABASE_URL` in their cache key and `vp` must see its value. See
[One Postgres container, a database per worktree (ADR 0049)](./docs/adr/0049-one-postgres-container-a-database-per-worktree.md).

```bash
vp run dev:db        # once per checkout: starts the container if needed, creates this
                     # checkout's database, writes mise.local.toml
vp run dev           # thereafter, in any shell with mise activated
```

`BEBOP_DEV_DATABASE_NAME` overrides the derived database name. The container keeps `tmpfs` storage, so nothing
survives a container restart — re-run `vp run dev:db` to recreate a checkout's database.

### Postgres for component tests

Bebop's component tests run against a **real disposable Postgres** — the behaviour they cover is behaviour a
fake would paper over: transactional idempotency, `FOR UPDATE SKIP LOCKED`, advisory locks, and the `jsonb` and
`bigint` encodings recorded in `prototypes/persistence`. Each suite creates its own database and drops it afterwards.

```bash
docker compose up -d --wait postgres
export BEBOP_TEST_DATABASE_URL=postgres://bebop:bebop@127.0.0.1:5433/bebop
vp run ready
```

`vp run dev:db` sets `BEBOP_TEST_DATABASE_URL` for you through `mise.local.toml`; the export above is only
needed when you do not use mise. Without `BEBOP_TEST_DATABASE_URL` those suites skip, so `vp run ready` still
passes on a machine with no Docker. CI always provides the service, and that is where the requirement is
enforced.

### Why the test tasks launch Vitest with Bun

One test runner, one runtime. The `test`, `test:integration`, and `test:e2e` tasks run
`bun node_modules/vitest/vitest.mjs` rather than `vp test`, because Vite+ manages a Node runtime and launches
Vitest with it — which would put every test on a runtime the code under test never runs on. The API serves on
`BunHttpServer`; a Node-hosted worker cannot start one at all, and a unit test that passes on Node proves less
than one that passes on Bun.

Launched by Bun, Vitest's workers are Bun workers: `Bun` globals resolve, `BunHttpServer` starts, and the
component suites are ordinary Vitest tests alongside everything else.

`vitest` is therefore a direct devDependency pinned in the catalog to the same version Vite+ vendors. Keep the
two in step when upgrading Vite+ — a mismatch is the one way this arrangement can drift.

`vp test` still works for an ad-hoc run of the pure tests, and forwards its options to Vitest as usual. It runs
on Node, so it cannot start the component suites.

Tasks declare their own prerequisites with Vite+ `dependsOn` in `vite.config.ts` rather than being chained with
shell `&&`, so every task is correct when run on its own from a clean checkout — `vp run smoke` builds what it
needs before it runs. `ready` is an aggregator whose gate is its dependencies.

Two constraints shaped that wiring:

- `check` and the test tasks resolve `@bebop/contracts` through its built `dist`, so they depend on `build`;
- Vite+ resolves a bare `./dist/*.mjs` command as a binary at _plan_ time, before any task runs, so no task
  names a built artifact directly. The artifact smokes run through a script instead
  (`apps/bebop/scripts/smoke.ts`), which also lets them assert something worth asserting: that each packed
  bundle **loads and reaches its own code**, proved by the servers reporting a configuration error and the CLI
  printing its usage. A missing dependency or a dynamic import that did not survive bundling fails there, and
  none of those are visible from a type check.

Run individual checks:

```bash
vp check
vp test --run
vp run build
```

Run the Bebop API locally:

```bash
docker compose up -d --wait postgres
BEBOP_HOST=127.0.0.1 \
BEBOP_PORT=8080 \
BEBOP_DATABASE_URL=postgres://bebop:bebop@127.0.0.1:5433/bebop \
BEBOP_PUBLIC_BASE_URL=https://bebop.local.invalid/ \
BEBOP_ARTIFACT_ROOT=/tmp/bebop-artifacts \
BEBOP_HEARTBEAT_INTERVAL='5 seconds' \
BEBOP_SWORDFISH_STALE_AFTER='20 seconds' \
BEBOP_MAX_PROTOCOL_MESSAGE_BYTES=262144 \
BEBOP_SHUTDOWN_TIMEOUT='15 seconds' \
BEBOP_SWORDFISH_CREDENTIAL_KEY='replace-with-at-least-32-random-bytes' \
BEBOP_BOOTSTRAP_API_TOKEN='bebop_replace-with-a-random-bootstrap-token' \
vp run dev
```

With mise active, `vp run dev:db` has already set `BEBOP_DATABASE_URL` to this checkout's database, so that
line can be dropped; the block stays complete for a shell without mise.

`BEBOP_BOOTSTRAP_API_TOKEN` seeds the first named API token only when `api_tokens` is empty. Create the normal
client tokens through `/api/tokens`, then remove the bootstrap value from the environment. It is never reapplied
after a token row exists.

`BEBOP_SWORDFISH_CREDENTIAL_KEY` must be at least 32 characters and must remain stable while bounties are live.
It derives retry-stable bounty credentials without storing their plaintext; changing it invalidates reconnects
for VMs provisioned under the previous key.

`bebop-worker` takes the same configuration and runs the durable lifecycle jobs and the connection freshness
sweep. Both processes apply migrations at startup, so either one may be started first.

Run Swordfish under Vite+'s development supervisor:

```bash
SWORDFISH_BOUNTY_ID=bty-local \
SWORDFISH_VM_ID=vm-local \
SWORDFISH_REPOSITORY=withco/bebop \
SWORDFISH_ASSIGNED_BRANCH=bounty/bty-local \
SWORDFISH_BEBOP_WEB_SOCKET_URL=ws://127.0.0.1:8080/swordfish \
SWORDFISH_BEBOP_TOKEN=replace-with-the-bounty-token \
SWORDFISH_DATABASE_PATH=/tmp/swordfish/state/swordfish.sqlite \
SWORDFISH_CONTROL_SOCKET_PATH=/tmp/swordfish/run/control.sock \
SWORDFISH_REPOSITORY_PATH=/tmp/swordfish/repository \
SWORDFISH_ARTIFACT_ROOT=/tmp/swordfish/artifacts \
SWORDFISH_OPEN_CODE_BASE_URL=http://127.0.0.1:4096/ \
SWORDFISH_HEARTBEAT_INTERVAL='5 seconds' \
SWORDFISH_RECONNECT_MINIMUM_DELAY='100 millis' \
SWORDFISH_RECONNECT_MAXIMUM_DELAY='10 seconds' \
SWORDFISH_SHUTDOWN_TIMEOUT='15 seconds' \
vp run @bebop/swordfish#dev
```

### Run one bounty end to end, locally

The block above runs a Swordfish by hand against a bounty that already exists. To go the other way — create a
bounty and have its machine appear — turn on local machine mode. The lifecycle provider is what makes a daemon
exist in both environments, so locally it clones the working copy and starts the process
([A local Swordfish outlives the worker that started it (ADR 0048)](./docs/adr/0048-a-local-swordfish-outlives-the-worker-that-started-it.md)).
No manual daemon step sits in between.

Two GitHub identities are in play, from two sources, exactly as in production. **Bebop** uses its own App
installation for pull requests, check polling, and ruleset verification. **The machine** uses your ambient `git`
and `gh` credentials — the provider injects nothing for GitHub, which is structurally what exe.dev's
repository-scoped integration provides.

#### Bebop's GitHub App

Bebop's half is a real App installation rather than a token you paste, so the credential-acquisition path
shipped to production is the one exercised on a laptop
([The local loop runs the production assembly (ADR 0046)](./docs/adr/0046-the-local-loop-runs-the-production-assembly.md)).
Create the App on your own account, install it on the target repository alone, and grant it exactly **Contents:
read and write**, **Pull requests: read and write**, **Checks: read-only**, **Commit statuses: read-only**, and
the mandatory **Metadata: read-only** — nothing more. Not `Issues`, and not `Administration`;
[The merge target must enforce rulesets (ADR 0034)](./docs/adr/0034-the-merge-target-must-enforce-rulesets.md)
records why each is enough and why those two are refused. Keep both files outside every working copy — a bounty
clones into `$BEBOP_LOCAL_HARNESS_ROOT`, and a private key inside that tree is one a seat can read:

```bash
~/.config/bebop/github-app.pem   # the App's private key, mode 600, never in a checkout
~/.config/bebop/github-app.env   # the three values below

set -a; source ~/.config/bebop/github-app.env; set +a   # into the shell running the block below
```

The values are `BEBOP_GITHUB_APP_ID`, `BEBOP_GITHUB_APP_INSTALLATION_ID`, and
`BEBOP_GITHUB_APP_PRIVATE_KEY_PATH`, read from the environment like every other knob in
`apps/bebop/src/config.ts` — by the GitHub client that arrives with pull-request creation. The key is named by
**path** rather than pasted inline, which is what lets a deployment swap the file for a mounted secret without
changing the shape
([The master runs on exe.dev (ADR 0019)](./docs/adr/0019-the-master-runs-on-exe-dev-with-mandatory-off-vm-backups.md)).

The target repository must be one GitHub will protect — public, or private on Pro or above — carrying a ruleset
on its default branch whose `bypass_actors` is empty
([The merge target must enforce rulesets (ADR 0034)](./docs/adr/0034-the-merge-target-must-enforce-rulesets.md)).
That ruleset has no admin exemption, so your own `git push` to that branch is refused too, with `GH013`. That is
the protection working, not a misconfiguration, and it is worth meeting deliberately rather than mid-bounty.

```bash
docker compose up -d postgres

# Both bebop processes take the same environment. Add these to the block above:
export BEBOP_LOCAL_HARNESS_ROOT=/tmp/bebop-local
export BEBOP_LOCAL_SWORDFISH_ENTRYPOINT="$PWD/apps/swordfish/dist/daemon.mjs"
# Optional. Defaults to https://github.com/, cloned with your ambient git credentials.
export BEBOP_LOCAL_GIT_REMOTE_BASE=https://github.com/

vp run build                              # the entrypoint above must exist before a bounty is created
vp run dev                                # bebop-api
bun apps/bebop/src/worker.ts              # bebop-worker, same environment, in a second shell

bebop bounty create --repository withco/bebop --base-ref main --compute-profile small \
  --idempotency-key local-1 --url http://127.0.0.1:8080 --token "$BEBOP_BOOTSTRAP_API_TOKEN"
```

Creating the bounty is the whole ceremony. The worker provisions it, which clones the repository and starts a
detached daemon; from there `sf` drives it:

```bash
BOUNTY=bty-...          # printed by `bounty create`
ROOT=$BEBOP_LOCAL_HARNESS_ROOT/bounties/$BOUNTY
export SWORDFISH_CONTROL_SOCKET_PATH=$ROOT/run/control.sock

sf status
tail -F "$ROOT/logs/swordfish.log"
```

Reading is unauthenticated over the socket; every mutating command is not. Retrieve this bounty's operator
credential from bebop and enter it at the hidden prompt each command opens:

```bash
bebop bounty operator-credential --bounty "$BOUNTY" \
  --url http://127.0.0.1:8080 --token "$BEBOP_BOOTSTRAP_API_TOKEN"

sf cancel                 # and takeover, handoff, continue, rerun, resume
```

Each bounty owns `$BEBOP_LOCAL_HARNESS_ROOT/bounties/<bountyId>/`: `repository/` is its clone, `state/` its
SQLite, `run/` the control socket and the machine record, `logs/` the daemon output. Two bounties never collide,
and a re-provision reattaches to a daemon that is already running rather than starting a second.

The machine record, `run/machine.json`, is how a re-provision tells "still running" from "gone": it holds the
`vmId`, the pid, and the process start time the operating system reports. The start time is what makes it an
identity rather than a slot — after a crash the pid alone could belong to something else entirely, and bebop
would otherwise reattach to it or, worse, signal it.

The daemon is **detached on purpose** and outlives the worker, so stopping bebop does not stop it — `sf status`
reports the connection as disconnected and keeps retrying with backoff, which is a normal state rather than an
error. Destroying the bounty is what stops it:

```bash
curl -X DELETE -H "authorization: Bearer $BEBOP_BOOTSTRAP_API_TOKEN" \
  http://127.0.0.1:8080/api/bounties/$BOUNTY
```

If a daemon is ever orphaned, the record is the handle: `kill $(jq -r .pid "$ROOT/run/machine.json")`.

`BEBOP_LOCAL_HARNESS_ROOT` is local-only and logs a warning at startup: it turns bebop into a process that
spawns daemons and clones repositories on its own host.

The daemon owns SQLite and exposes only the mode-`0600` Unix control socket. Point `sf` at that socket with
`SWORDFISH_CONTROL_SOCKET_PATH` or `--socket`; commands never read or mutate the database directly. The current
CLI implements status, cancel, takeover, handoff, continue, rerun, and resume, with hidden-entry operator
credential enforcement on every mutating command. It still lacks compact watch and events, attach, and the
role-aware workflow actions. Config approval and VM lifecycle remain bebop-side.

All commits must follow Conventional Commits. Vite+ installs the pre-commit and commit-message hooks through the
root `prepare` script.
