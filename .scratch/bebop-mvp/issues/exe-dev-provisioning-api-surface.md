---
type: research
status: open
blocked-by: [provision-exe-dev-access]
---

# What does exe.dev's provisioning API actually offer, and where does it fail?

Resolving this updates [Provisioning and attachment](../../../docs/capabilities/02-provisioning-and-attachment.md).

## Question

Bebop's `LifecycleProvider` is currently a fake that creates deterministic local records
(refuse rather than pretend — [`ABSTRACT.md`](../../../ABSTRACT.md) §3.10). Before a real adapter can sit at that seam,
the provider's real interface has to be known.

Establish:

- the create/attach/stop/destroy operations, their latencies, and which of them are asynchronous;
- whether creation is idempotent under a client-supplied key, or whether bebop must reconcile by tag — this
  decides whether provisioning retries can be made safe the way
  [Bounty-scoped Swordfish tokens (ADR 0014)](../../../docs/adr/0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md) needs;
- how integrations are attached to a VM, and whether that is part of creation or a second call that can fail
  independently;
- what a custom base image costs to build, store, and boot, and how it is versioned;
- how private URLs and SSH attachment metadata are obtained and how long they stay valid;
- what VM loss looks like from the API's side — is a lost VM distinguishable from an unreachable one?

The last point is the one the design most depends on:
[recovery](../../../docs/capabilities/13-recovery-and-reliability.md) assumes bebop can tell.
