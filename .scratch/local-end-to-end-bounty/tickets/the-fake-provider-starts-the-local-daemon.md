---
type: build
status: open
---

# The fake provider starts the local Swordfish daemon

Resolving this updates [Provisioning and attachment](../../../docs/capabilities/02-provisioning-and-attachment.md).

## Background

[The local loop runs the production assembly (ADR 0046)](../../../docs/adr/0046-the-local-loop-runs-the-production-assembly.md)
settles that the lifecycle provider is what makes a Swordfish daemon exist in both environments — in production
by having the VM's bootstrap start it, locally by starting the process directly. Today the local half of that
stops one step short: the fake provider derives the identity and writes the one-shot bootstrap artifact, but the
only thing that consumes the artifact and starts a daemon is a function inside
`test/local-system/harness.test.ts`. That is why `vp run local-system` can run the loop end to end and a person
cannot.

The artifact carries `bountyId`, `vmId`, `swordfishToken`, and `operatorCredentialVerifier`, mode `0600` under a
mode `0700` root. The remaining daemon configuration — socket path, database path, repository path, artifact
root, OpenCode base URL — is not in it and has to come from somewhere the provider decides.

Keeping this inside the provider is what keeps bebop core ignorant of how a machine comes to be running: it
calls `provision`, and the difference between an API call and a spawned process lives in the one implementation
exe.dev replaces.

## Scope

- Starting the daemon becomes part of the fake provider's `provision`, with `destroy` stopping it. Both stay
  idempotent per bounty, since the worker retries provisioning after a crash and must not end up with two
  daemons for one bounty.
- Derive per-bounty paths — SQLite, control socket, working copy, artifacts — from a single local root, so two
  concurrent local bounties do not collide.
- Clone the repository into the bounty-scoped working copy. Never the operator's own checkout: ADR 0046 is
  explicit, and a dirty tree makes both the clean-room worktree and the candidate precondition meaningless.
- Settle process lifetime, and write down what was chosen. A daemon spawned from the worker dies with it unless
  detached, and a worker restart must reattach to or replace a daemon that is already running rather than
  spawning a second. Neither answer is obvious and the wrong one is invisible until a restart.
- Decide what remains of the bootstrap artifact. Its purpose was handing the credential to a separate consumer;
  with the provider starting the process there may be no consumer left, except that the local-system harness
  needs the credential to open its own gateway connection.
- Replace the harness's private copy with the shipped path, so the thing tests exercise is the thing operators
  run.

## Done when

- An operator can go from `bounty create` to a running Swordfish daemon with no manual step in between, and
  `sf status` answers over the control socket.
- Two local bounties run concurrently without colliding on socket, database, or working-copy paths.
- A retried provision does not produce a second daemon; `destroy` leaves none running.
- `test/local-system/` drives the shipped path rather than its own.
- The README gains the local bounty runbook — `docker compose up`, start the API and worker, create the bounty,
  drive it with `sf` — replacing the pointer that currently says the loop is not runnable by hand. The two
  GitHub identities belong in it: bebop's App installation, and the operator's ambient credentials on the
  machine.
- `vp run ready` passes.
