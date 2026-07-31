# Readiness is a claim, not authority

Swordfish may claim that a commit is ready; bebop never takes that claim as authority. Before merge is offered, bebop independently verifies that the assigned branch still points at that commit, that the required GitHub checks passed for it, that Swordfish's required stages passed for it, that the effective-spec revision matches, and that no privileged-path change remains unapproved.

This is the rule that makes the whole sandbox model hold. Everything Swordfish reports comes from inside the bounty VM, which the crew can write to; if bebop trusted the claim, the sandbox would effectively hold merge authority.

## Consequences

The verification is re-run against live state, so readiness can be lost without any Swordfish event — a push after readiness silently removes it, and `bounty list` must show ready only for the verified head SHA.
