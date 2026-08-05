---
type: grilling
status: open
blocked-by: [opencode-version-pin-and-upgrade-qualification]
---

# What happens when bebop declares a bounty's runtime manifest defective?

## Question

A runtime manifest binds a bounty execution environment to an exact VM image and Swordfish release. OpenCode is
an internal Swordfish dependency, so a bad OpenCode release, a broken `sf` client, or a defective image all have
the same recovery shape: the environment itself is no longer trustworthy, and asking software inside it to
repair its own authority is the wrong seam.

Settle the bebop-side escape hatch for declaring that failure non-transient:

- how bebop fences the current Swordfish credential and rejects late traffic from the defective environment;
- whether the VM remains available for manual salvage, for how long, and what attachment metadata survives;
- which bounty facts survive into a replacement environment: identity, branch, effective spec, candidate,
  artifacts, findings, gate outcomes, and constraint history;
- whether a replacement may be another exe.dev VM, a locally running Swordfish, or either, and how it proves
  authority to bebop;
- whether the replacement resumes a projected stage or starts a fresh Swordfish loop against the surviving
  branch and effective spec;
- what happens when the operator salvages the branch manually and wants to merge without another Swordfish
  readiness claim;
- whether declaring one runtime manifest defective blocks new bounties or warns/fences every existing bounty on
  the same manifest; and
- whether **rogue** is the canonical name for the bounty's durable provenance after this escape hatch is used.

The escape hatch must not grant the sandbox merge authority. Bebop remains the only actor that can catch the
bounty, and any weakened verification must be explicit and permanently visible.
