# One Postgres container, a database per worktree

Every checkout on a developer's machine shares a single local Postgres container, and each checkout gets its
own database on it, named after its directory. `compose.yml` pins the compose project name to `bebop` so
`docker compose up` is idempotent from any worktree; `scripts/dev-db.ts` ensures the container is up, creates
the checkout's database, and records both database URLs in the gitignored `mise.local.toml`, which mise loads
into the shell.

Worktrees are the normal way bebop is worked on, and the old setup did not survive them. The compose project
name defaulted to the checkout's directory, so a second worktree running `docker compose up` started a second
container that fought over host port 5433. And both checkouts defaulted their dev database to the one seeded
`bebop` database, so two dev loops on different branches migrated and wrote the same schema and rows. The test
suites never had this problem — each creates and drops its own randomly named database through
`BEBOP_TEST_DATABASE_URL`, which is why that URL can stay shared across all checkouts.

## Why the URLs live in `mise.local.toml` and not `.env`

The `test` and `local-system` tasks fingerprint `BEBOP_TEST_DATABASE_URL` in their cache key
(`vite.config.ts`), so `vp` itself must see the value when it plans a task: a run with a database and a run
without one are deliberately not the same cached run. A `.env` file would only be loaded by a child Bun process
from its own working directory, invisible to `vp` at plan time, so it would silently break that guarantee.
mise sets real process environment, which both the cache key and every spawned process see. `mise.local.toml`
is gitignored, machine-local, and mise is already an implicit developer dependency in the same sense `vp` is.

## Consequences

- The database name derives from the checkout's directory: the main checkout uses the seeded `bebop` database,
  a worktree uses `bebop_<sanitized basename>`, and `BEBOP_DEV_DATABASE_NAME` overrides the derivation. The
  `bebop_` prefix keeps the name out of reserved-word territory and within Postgres's 63-byte identifier limit.
- The container keeps `tmpfs` storage, so a restart wipes every checkout's database. Recovery is re-running
  `vp run dev:db`; nothing is lost that was not disposable anyway, which is the same bargain the tests already
  made.
- `scripts/dev-db.ts` reaches the database through `docker compose exec -T postgres psql`, which needs no
  Postgres client installed, does not depend on the published port, and resolves the pinned project name from
  any checkout.
- Compose configuration still lands from the main checkout. A worktree whose branch edits `compose.yml` would
  recreate the shared container when it ran `docker compose up`, which is why the docs say to start the
  container once and let `scripts/dev-db.ts` do it from then on.
