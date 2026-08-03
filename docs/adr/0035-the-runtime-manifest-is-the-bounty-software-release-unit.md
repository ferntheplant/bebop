# The runtime manifest is the bounty software release unit

Bebop binds each bounty execution environment to an immutable runtime manifest identifying its VM image digest
and Swordfish release. The Swordfish release's bill of materials pins coupled internal dependencies, including
the OpenCode executable, SDK, and plugin; those dependencies are not independently mutable bounty configuration.
Status and evidence refer to the runtime manifest so one identity names the software environment that produced
the work.

The alternative was to version and override OpenCode independently inside a live bounty. That creates valid but
unmanageable combinations of image, Swordfish, SDK, plugin, and executable, and makes recovery reason about which
individual dependency broke. A manifest keeps release qualification and defect recovery at the level actually
deployed and tested.

## Consequences

Managed processes disable OpenCode auto-update and refuse to start when the installed bill of materials differs
from the runtime manifest. Existing bounties do not receive in-place release upgrades; a qualified manifest
becomes the default only for new bounties. A defective manifest is handled by fencing, salvage, or replacement
rather than by silently changing one dependency inside the environment.
