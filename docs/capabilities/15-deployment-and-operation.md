# Deployment and operation

What you run and maintain to have a Bebop at all. One always-on service — bebop itself — on one computer, with
the operational shape of a production system even though it is a single host.

## What you can expect

- **One long-lived master VM** on exe.dev, providing private HTTPS ingress and identity without any public
  surface to defend.
- **Containerised modules behind a reverse proxy.** Docker Compose runs Caddy, `bebop-api`, `bebop-worker`, and
  Postgres. The API and worker may share one image while remaining separate logical responsibilities.
- **Blue/green deploys.** Two compose colours behind Caddy: start the new colour, health-check it, flip the
  upstream, drain the old. Health checks reach `GET /api/health`, the one unauthenticated route, so no credential
  has to be baked into an image just to ask a process whether it is alive.
- **Backward-compatible migrations**, so a flip does not require the two colours to agree on schema.
- **Persistent volumes** for Postgres and for the evidence artifact store.
- **Process supervision** and structured JSON logs carrying `bounty_id`, `vm_id`, `seat`, `stage`,
  `candidate_sha`, and correlation IDs.
- **Backups that are actually tested.** A nightly `pg_dump` plus the artifact volume in one encrypted restic
  snapshot to off-VM S3-compatible storage, alerting on failure, with a sampled restore tested monthly.
- **An observability floor**: structured logs everywhere, plus stage timings, token spend per seat, and gate
  pass/fail rates.

## What you should not expect

- **No host-level high availability.** Loss or reboot of the master VM causes downtime. Bounties keep working
  through it — only operations needing bebop's authority wait — but the API is gone until the host is back.
- **No public ingress**, and therefore no inbound webhooks. CI is observed by polling.
- **Correlated failure by construction.** The master, every bounty, the canonical database, and the evidence
  volume share one provider, one account, and one region. Mandatory off-VM backups exist because of exactly this.

## Where it stands

**Designed.** Bebop runs locally against Postgres today; nothing is containerised, deployed, proxied, or backed
up. The seams that keep this reversible are real, though — bebop talks to exe.dev over the public provisioning
API, accepts outbound connections, stores evidence through a backend-neutral blob contract, and authorises
against Postgres rather than exe.dev-local identity.

## When to move off exe.dev

Move the master to a traditional provider when webhook ingestion, managed Postgres or object storage, host
availability, independent capacity, or a reduced exe.dev blast radius becomes worth more than built-in private
ingress. That is a deployment change, not a rewrite.

## Acceptance criteria

**None directly** — like [the security model](./14-the-security-model.md), this is a property of the system
rather than a stage with its own test. Criterion **42** (restarting Swordfish or bebop does not duplicate VMs,
prompts, PRs, or merges) is the closest, and it belongs to
[recovery and reliability](./13-recovery-and-reliability.md).

## Decisions

- [The master runs on exe.dev (ADR 0019)](../adr/0019-the-master-runs-on-exe-dev-with-mandatory-off-vm-backups.md)
  — convenience today, deployment-neutral seams, mandatory off-VM backups, and the conditions for leaving.
- [Postgres for bebop, SQLite for Swordfish (ADR 0008)](../adr/0008-postgres-for-bebop-sqlite-for-swordfish.md)
  — bebop is a long-lived service needing transactions, durable queues, and blue/green deploys.
- [API first, with a thin CLI (ADR 0006)](../adr/0006-api-first-with-a-thin-cli.md) — why `GET /api/health` is
  the single unauthenticated route.
- [Effect on Bun for every process (ADR 0005)](../adr/0005-effect-on-bun-for-every-process.md) — one stack across
  every deployable, and the measured criteria for reconsidering it.

Background work runs as durable job rows in Postgres worked by Effect fibers in `bebop-worker`; a cluster
runtime is only worth adding if that outgrows a single worker.

Bounded shutdown, which is what makes a blue/green drain terminate, is in
[`docs/gotchas.md`](../gotchas.md#process-lifecycle).

## Still open

- **Operating a bounty fleet** — fog on [the map](../../.scratch/bebop-mvp/map.md): what the operator sees when
  six bounties are live, which failures page a human, and what the observability floor actually needs beyond
  structured logs.
- **Release qualification** — also fog: migration-from-previous-version, stress runs, and backup restore, beyond
  the acceptance criteria themselves.
