---
type: build
status: open
---

# Ship the supervisor that starts a local Swordfish daemon

## Background

[The local loop runs the production assembly (ADR 0046)](../../../docs/adr/0046-the-local-loop-runs-the-production-assembly.md)
settles that neither peer supervises the other and that the Swordfish daemon is started from the one-shot
bootstrap artifact the fake lifecycle provider writes. That supervisor exists only as a function inside
`test/local-system/harness.test.ts`, which is why `vp run local-system` can run the loop end to end and a person
cannot. Everything else in the local mode is reachable by hand; this is the one step that is not.

The artifact carries `bountyId`, `vmId`, `swordfishToken`, and `operatorCredentialVerifier`, is written mode
`0600` under a mode `0700` root, and is consumed once and destroyed — the property that keeps the machine
credential on the single path
[Swordfish tokens are bounty-scoped (ADR 0014)](../../../docs/adr/0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md)
defines. The remaining daemon configuration — socket path, database path, repository path, artifact root,
OpenCode base URL — is not in the artifact and has to come from somewhere the supervisor decides.

## Scope

- A supervisor entrypoint that takes a bounty id, consumes its bootstrap artifact, and starts the daemon with
  the identity and credential bebop derived. Where it lives is part of the work: a `bebop` CLI subcommand keeps
  it with the process that wrote the artifact, but the CLI has no behaviour the API lacks
  ([API first, with a thin CLI (ADR 0006)](../../../docs/adr/0006-api-first-with-a-thin-cli.md)), and starting a
  local process is not an API operation. A `vp` task or a separate small binary may be the honest answer.
- Derive the per-bounty paths — SQLite, control socket, working copy, artifacts — from a single local root, so
  two concurrent local bounties do not collide.
- Clone the repository into the bounty-scoped working copy. Never the operator's own checkout: ADR 0046 is
  explicit, and a dirty tree makes both the clean-room worktree and the candidate precondition meaningless.
- Refuse clearly when the artifact is absent or already consumed, naming which.
- Replace the harness's private copy with the shipped one, so the thing tests exercise is the thing operators
  run.

## Done when

- An operator can go from `bounty create` to a running Swordfish daemon without reading a credential out of a
  file by hand, and `sf status` answers over the control socket.
- Two local bounties run concurrently without colliding on socket, database, or working-copy paths.
- `test/local-system/` drives the shipped supervisor rather than its own.
- The README's local runbook drops its "step 3 is not shipped" caveat.
- `vp run ready` passes.
