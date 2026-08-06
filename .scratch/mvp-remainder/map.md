# The MVP remainder: remote computers and the ship

Label: `wayfinder:map`

## Destination

Everything between a working local loop and the MVP acceptance criteria in [`ABSTRACT.md`](../../ABSTRACT.md)
§8: the same loop, on computers bebop provisions and can lose.

That is exe.dev provisioning and integration attachment, the deployed master stack, attachment metadata,
bebop-authorized merge and deprovisioning, and the reliability work that only matters once bebop owns
infrastructure — criteria 3, 4, 38, 39, 41, and the VM halves of 2 and 5.

## Notes

**Stub map — a holding pen, not a chart.** [The local loop](../local-end-to-end-bounty/map.md) is the live
project. This map exists to give the remainder an address, so tickets that are real but not next have somewhere
honest to sit instead of being forced into the live map. Its Notes and fog get written when work reaches here.

**Its tickets are not idle, though.** exe.dev is a long-lead external unknown: nothing about it can be judged
without an account and a VM that can actually be created and destroyed. Answering those questions early is
cheap and keeps the local design from quietly assuming something the provider will not do.
[Provision exe.dev access and record where its credentials live](./tickets/provision-exe-dev-access.md) gates
three of them and is the highest-leverage ticket here by a distance.

## Decisions so far

<!-- one line per decision not yet absorbed into an ADR, capability, or gotcha -->

## Not yet specified

- **Operating a bounty fleet.** What the operator sees when six bounties are live, which failures page a human,
  and what the observability floor needs beyond structured logs.
- **Release qualification.** What has to pass before the MVP is called done, beyond the acceptance criteria —
  migration-from-previous-version, stress runs, backup restore.

## Out of scope

- Public API ingress, and therefore GitHub webhooks — [Swordfish connects outbound only (ADR 0013)](../../docs/adr/0013-swordfish-connects-outbound-only.md).
- Daytona or self-hosted compute, warm per-repo VM snapshots, multihost bebop, a branch-scoped Git gateway.
- Transparent recovery after permanent VM loss — [`ABSTRACT.md`](../../ABSTRACT.md) §5 declines to guarantee it.
- Large projects, extended crew, rich clients, and task-system integrations — unchanged from §5.
