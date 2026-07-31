# The VM is the sandbox; ein runs allow-all

The isolation seam is the bounty VM, not the agent harness. Inside it, ein runs with full permissions and no permission prompts in autonomous mode; jet and faye are locked to their roles' tools; stray permission events are denied and logged. The harness does not enforce permissions a second time.

An agent that must ask before running a build is an agent that stalls in autonomous mode, and a permission model spread across the harness and the VM has two places to get wrong. High-value authority — merge, provisioning, reusable credentials — is what stays outside the sandbox instead.

## Consequences

Anything the crew can reach from inside the VM is reachable by a confused or compromised agent, which is exactly why merge authority, GitHub App credentials, and provider keys live with bebop and why [readiness is a claim](./0003-readiness-is-a-claim-not-authority.md).
