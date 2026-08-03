# Bounty lifecycle

A bounty is the unit you create, watch, and finish. Everything else in this catalogue happens inside one. You
create it with a repository, a base ref, a compute profile, and the context integrations its work will need;
from then on it has an identity that outlives any computer it runs on.

## What you can expect

- **Create a bounty** from the CLI or any API client, optionally with an opening prompt.
- **List and inspect** every bounty, with a compact status — `provisioning`, `interactive`, `autonomous`,
  `human_controlled`, `needs_attention`, `ready`, `cancelled`, `merging`, `done`, `failed`, `stopped` — and the
  detailed Swordfish stage alongside it. `cancelled` means the inner loop ended while the VM remains available;
  `stopped` means the VM lifecycle stopped.
- **Follow one live** over SSE with cursor replay, so a client that reconnects misses nothing and never has to
  poll.
- **Stop** a bounty that is going nowhere, or **destroy** it outright.
- **Cancel only the inner loop** with authenticated `sf cancel` while leaving Swordfish, the cockpit, and the VM
  alive for inspection; only bebop stops or destroys the VM.
- **See a bounty end**: catching it marks it done and deprovisions the VM after a grace period.
- Bounty records outlive their computers. A bounty whose VM is lost keeps its identity, its branch, its effective
  spec, and its evidence.

Every command takes `--json`, and the CLI has no behaviour the API lacks.

## Where it stands

**Partial.** Create, list, status, events, stop, destroy, and the token routes run against Postgres through the
real API and CLI. The lifecycle provider underneath is a fake that creates deterministic local VM records and is
honest about being local. Status is computed on read, never stored.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **1** (create from the local CLI) and **41** (after merge,
marked done and deprovisioned).

## Decisions

- [The bounty primitive (ADR 0001)](../adr/0001-the-bounty-primitive.md) — one VM, one branch, at most one PR,
  and why decomposition is built from this rather than into it.
- [Bebop owns authority, Swordfish owns the loop (ADR 0002)](../adr/0002-bebop-owns-authority-swordfish-owns-the-loop.md)
  — which side of the trust line each piece of state sits on.
- [API first, with a thin CLI (ADR 0006)](../adr/0006-api-first-with-a-thin-cli.md) — why SSE ships in the MVP
  even though the CLI barely needs it.
- [Postgres for bebop, SQLite for Swordfish (ADR 0008)](../adr/0008-postgres-for-bebop-sqlite-for-swordfish.md)

## Still open

- [What are the compute profiles, retention windows, and orphan sweeps?](../../.scratch/bebop-mvp/issues/13-compute-profiles-retention-and-orphans.md)
