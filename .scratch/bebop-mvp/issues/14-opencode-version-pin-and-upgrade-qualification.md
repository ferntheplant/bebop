# How is the OpenCode pin enforced, and what qualifies an upgrade?

Type: grilling
Status: open

## Question

OpenCode 1.18.5 is pinned in the root catalog and destined for the base image
([provisioning](../../../docs/capabilities/02-provisioning-and-attachment.md)), with upgrades qualified by a
"smoke bounty" — a phrase that currently means nothing concrete.

This matters more than a normal dependency pin because
[the whole product is committed to OpenCode (ADR 0004)](../../../docs/adr/0004-commit-to-opencode-with-no-harness-abstraction.md)
and because [the four-layer control lease (ADR 0009)](../../../docs/adr/0009-the-control-lease-is-enforced-in-four-layers.md) depends
on which routes invoke plugin hooks — a fact that can change in a patch release without any announcement.

Settle:

- where the pin is enforced, and how the image, the catalog, and the plugin's peer dependency are kept in step;
- what a smoke bounty runs, and which of the acceptance criteria it must exercise to count as qualification;
- specifically, which lease-guard assertions re-run on every upgrade — the prototype's finding is that a new
  unhooked route is exactly the kind of regression that ships silently;
- what happens to live bounties when a new image is published mid-flight;
- whether a bounty records the OpenCode version it ran under in its evidence bundle.
