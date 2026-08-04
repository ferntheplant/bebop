# Retrieve the operator credential and enforce it on mutating `sf` commands

Type: task
Status: open

## Question

This is the second half of operator authentication and the direct continuation of the credential plumbing that
landed with it. The plumbing PR moved derivation into Bebop, computed a SHA-256 verifier at provision time, and
delivered it to the VM — but nothing enforces it and no human can obtain the plaintext, so the feature does
nothing yet. That was deliberate: enforcing without a retrieval route would ship a daemon that refuses every
mutating command with no way to satisfy it.

Build, in one change so the feature is usable the moment it is enforced:

- **Retrieval.** `POST /api/bounties/:bountyId/operator-credential`, returning the plaintext in a field declared
  `Schema.RedactedFromValue`, exactly as `CreateTokenResponse.secret` already does. Bebop recomputes it by
  derivation rather than reading storage, so there is nothing to lose or leak at rest. A thin
  `bebop bounty operator-credential --bounty <id>` CLI adapter over it, per
  [API first with a thin CLI (ADR 0006)](../../../docs/adr/0006-api-first-with-a-thin-cli.md).
- **The wire field.** `SfControlRequest.operatorCredential`, optional and `Redacted`, which moves `sf-control` to
  version 2. A v1 client cannot satisfy the requirement, so it is refused with `unsupported_version` rather than
  a misleading per-command error.
- **Enforcement.** The control server refuses any command other than `status` without a verifying credential,
  with a new `unauthorized` error code. This is every mutating and access-granting command — `cancel`,
  `takeover`, `handoff`, `continue`, `rerun`, `resume` — not `cancel` alone, per
  [Workflow actions have role-aware adapters (ADR 0038)](../../../docs/adr/0038-workflow-actions-have-role-aware-adapters.md).
- **The prompt.** Hidden interactive entry in the `sf` CLI. Never a flag, an environment variable, or a config
  file, so the credential cannot leak through a process listing or shell history. Empty input is a typed domain
  failure, not a schema defect.
- **Harness coverage.** The local system harness fetches the credential through the packed `bebop` CLI and feeds
  it to `sf cancel` over stdin, which exercises the retrieval route end to end through a real entrypoint rather
  than deriving anything test-side.
- **Documentation.** `docs/capabilities/01`, `05`, and `13` and the README currently describe an intent narrower
  than the implementation; correct them when the behaviour is real.

## Settled by the grilling session that produced this ticket

Do not re-litigate these without new information — they are recorded in
[ADR 0038](../../../docs/adr/0038-workflow-actions-have-role-aware-adapters.md):

- **The threat is a confused cowboy, not a compromised one.** A cowboy that hallucinates or is prompt-injected
  into running `sf` is stopped by a secret it was never told. An adversarial same-uid process inside the VM can
  shim `sf` on `PATH`, `ptrace` it, or `capture-pane` the tmux session, and is out of scope by
  [The VM is the sandbox (ADR 0012)](../../../docs/adr/0012-the-vm-is-the-sandbox.md). This is why the crypto is
  deliberately plain.
- **Derivation is deterministic and the credential never rotates**, matching
  [Swordfish tokens are bounty-scoped (ADR 0014)](../../../docs/adr/0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md).
  Recovery from a suspected leak is destroying the bounty's VM.
- **The real gate is the Bebop API token.** Tokens are unscoped today, so anyone who can call the retrieval route
  can already stop or merge the bounty. The credential proves the person at the `sf` prompt also holds Bebop
  access; it is not independently strong, and nothing should claim it is.

## Open within this ticket

- Whether retrieval emits an audit event on the bounty's stream. It is the only record of who took operator
  authority, and the event stream is where this repo puts durable facts — but it is also noise on a stream
  clients render. Decide when building.

Blocks [cockpit guidance for operator-authenticated commands](./23-cockpit-guidance-for-operator-authenticated-commands.md).
