---
type: grilling
status: open
blocked-by: [exe-dev-provisioning-api-surface]
---

# What are the compute profiles, retention windows, and orphan sweeps?

Resolving this updates [Bounty lifecycle](../../../docs/capabilities/01-bounty-lifecycle.md).

## Question

All provisional: small 2c/4GB, standard 4c/8GB default, large 8c/16GB; merged
bounties retained one hour, stopped or failed seven days, records forever; orphans reconciled by a periodic
tag-versus-Postgres sweep.

Settle, once [the provisioning API ticket](./exe-dev-provisioning-api-surface.md) has made the real costs and limits visible:

- whether three profiles earn their existence, and what actually determines the choice — the repository, the
  task, or the user;
- whether the standard profile can hold OpenCode, language servers, a repository build, dev services, and
  Playwright at once, which is the assumption
  [Effect on Bun (ADR 0005)](../../../docs/adr/0005-effect-on-bun-for-every-process.md) rests its runtime choice on;
- what the retention windows are for, given that a merged bounty's evidence outlives its VM — an hour is either
  generous or useless depending on what a human might still want to attach to;
- what the orphan sweep does when it finds a VM Postgres does not know about: destroy it, or park it and tell
  someone;
- who pays for a bounty parked in `needs_attention`, and whether idle bounties should be stopped and resumed.
