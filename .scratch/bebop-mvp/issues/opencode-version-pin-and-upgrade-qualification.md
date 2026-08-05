---
type: grilling
status: resolved
---

# How is the OpenCode pin enforced, and what qualifies an upgrade?

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

## Answer

OpenCode is not an independently configurable part of a live bounty. It is an internal dependency of a
Swordfish release, and that release is deployed as part of an immutable **runtime manifest** owned by bebop. The
manifest identifies the VM image digest and Swordfish release; the Swordfish release's bill of materials pins
`opencode-ai`, `@opencode-ai/sdk`, and `@opencode-ai/plugin` to one exact version. Status and evidence bundles
reference the runtime manifest, from which the exact Swordfish and OpenCode versions are recoverable.

The first version to pass the process will be OpenCode 1.18.11. It receives no bootstrap exception.

### Enforcing the pin

- The root catalog is the source for the exact CLI, SDK, and plugin versions. The workspace installs
  `opencode-ai`; development, tests, and the image invoke that locked executable rather than an ambient binary
  from `PATH`.
- Bebop-managed OpenCode processes set `OPENCODE_DISABLE_AUTOUPDATE=1`. OpenCode changes only as part of a new
  Swordfish release and runtime manifest.
- Swordfish verifies the executable, SDK, plugin, and runtime manifest bill of materials before starting a seat.
  Skew is an invalid release and fails startup rather than warning and continuing.
- A live bounty remains on the runtime manifest with which it started. New releases affect new bounties only;
  rollback repoints the default for future bounties and does not mutate active ones.

The broader escape hatch for a defective runtime manifest is not an in-place OpenCode override. Bebop must be
able to fence a defective execution environment and let the operator salvage or replace it. That recovery
protocol is a separate decision because it also covers a broken Swordfish or VM image.

### Qualifying an upgrade

An OpenCode change qualifies the OpenCode integration contract, not the entire bounty lifecycle. It covers
[`ABSTRACT.md`](../../../ABSTRACT.md) criteria 8-16, 23, and 31-33 without coupling the version gate to GitHub,
QA, evidence publication, or merge. Qualification has three mandatory stages:

1. `vp run ready` runs a real OpenCode process against a scripted local fake model. This suite is always in the
   normal gate because Swordfish or plugin changes can break the contract without changing OpenCode.
2. The immutable candidate image reruns the same suite and verifies its runtime manifest bill of materials.
3. A separately triggered smoke runs that candidate image against an explicitly supplied direct provider
   credential. It verifies authentication, streamed text, one tool-call/result round trip, cancellation, and a
   second turn in the same seat. It does not depend on exe.dev; exe.dev credential delivery remains the concern
   of the provider-integration tickets.

All three stages are required before a Swordfish/OpenCode release PR can merge. The paid provider smoke is
therefore an explicit pre-merge gate. Merging the qualified release makes its runtime manifest the default for
new bounties.

The hermetic suite grows with the supported OpenCode interface and must cover:

- exact version and bill-of-materials coherence;
- isolated authenticated server startup;
- session creation and reload after server restart;
- SSE text, tool, error, and idle events;
- synchronous prompts, asynchronous prompts, slash commands, and cancellation;
- the plugin's role-aware workflow actions;
- lease denial before the provider is contacted (`modelCalls === 0`);
- denial of the shell route without a seat credential;
- private-database isolation;
- feedback returning to the original seat; and
- takeover credential rotation and handoff.

Cases land alongside the feature that first depends on them. Qualification replays known mutation routes only;
for the MVP it does not snapshot or diff OpenCode's complete route inventory. A newly introduced unhooked route
may therefore be caught only by post-side-effect intrusion detection. That risk is accepted rather than pulling
a default-deny reverse proxy or route-inventory review into the MVP.
