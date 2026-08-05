---
status: shipped
---

# Brief: retrieve the operator credential and enforce it on mutating `sf` commands

Shipping this updates [Control lease and takeover](../../../docs/capabilities/05-control-lease-and-takeover.md).

## Scope

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

## Implementation notes worth not rediscovering

A first pass at enforcement was written and then discarded, because it predated the ADR
amendment above and encoded the design it replaced. Three things it found are worth keeping;
everything else about it is superseded and it is deliberately not preserved as a branch.

**Hiding the typed characters means intercepting readline's echo.** Node's `readline` has no
"hidden input" mode. It echoes through an internal `_writeToOutput`, and suppressing that is
what conceals typing. The shape that worked:

```ts
const isTerminal = process.stdin.isTTY === true;
const input = createInterface({ input: process.stdin, output: process.stdout, terminal: isTerminal });
let muted = false;
if (isTerminal) {
  // `_writeToOutput` is undocumented; guard it behind the TTY check so a piped stdin never
  // depends on it.
  const muter = input as unknown as { _writeToOutput: (data: string) => void };
  const original = muter._writeToOutput.bind(muter);
  muter._writeToOutput = (data: string) => {
    if (!muted) original(data);
  };
}
process.stderr.write(prompt); // stderr, so `--json` stdout stays machine-readable
muted = true;
input.question("", finish);
```

Two details that are easy to miss: the prompt goes to **stderr** so a `--json` invocation's
stdout remains parseable, and `input.on("close")` must reject when it fires before an answer,
or a closed stdin hangs the command instead of failing it.

**A piped stdin is a supported path, and the earlier comment claiming otherwise was wrong.**
With `terminal: false`, one line is read from the pipe. That is what lets the harness and the
integration suite drive `sf cancel`. It is fair to say the credential never appears in argv,
env, or a config file — so it cannot leak through a process listing or shell history — but not
that there is "no noninteractive bypass", because `echo "$CRED" | sf cancel` works.

**Empty input must be rejected before it reaches the schema.** Pressing Enter yields `""`,
which is not `undefined`, so it gets spread into the request and fails
`Schema.NonEmptyString` inside `decodeUnknownSync` — a defect with a stack trace rather than a
typed failure. Reject it at the prompt.

## Open within this brief

- Whether retrieval emits an audit event on the bounty's stream. It is the only record of who took operator
  authority, and the event stream is where this repo puts durable facts — but it is also noise on a stream
  clients render. Decide when building.

## What shipped

Delivered in one change, matching the "usable the moment it is enforced" framing:

- **Retrieval.** `POST /api/bounties/:bountyId/operator-credential` re-derives the credential from
  `BEBOP_SWORDFISH_CREDENTIAL_KEY` and returns it as `{ operatorCredential }`, declared
  `Schema.RedactedFromValue` with the matching `label` so the response encodes and a log interpolation cannot
  print it. The route 404s unless the bounty has a live attachment — the credential dies with the VM (ADR 0038) —
  mirroring `getBountyAttachments`. `bebop bounty operator-credential --bounty <id>` is the thin CLI adapter; its
  human output is the plaintext, and `--json` re-encodes the response through its own schema.
- **Wire field.** `SfControlRequest.operatorCredential`, optional and `RedactedFromValue`, ships with the control
  protocol at **version 2**, so a v1 client gets `unsupported_version` rather than a misleading per-command error.
- **Enforcement.** The control server refuses every command other than `status` without a credential whose
  SHA-256 digest matches the provisioned verifier, answered `unauthorized` with a constant-time comparison. A
  daemon without a provisioned verifier cannot enforce and does not — production provisioning always injects one;
  only the test harnesses run without it.
- **The prompt.** `sf` asks for the credential at a hidden readline prompt on every mutating command. Empty input
  and a closed stdin are typed domain failures, not schema defects; the prompt goes to stderr so `--json` stdout
  stays machine-readable. `echo "$CRED" | sf cancel` is a supported noninteractive path — the credential never
  appears in argv, env, or a config file.
- **Harness coverage.** The local system harness retrieves the plaintext through the packed `bebop` CLI and feeds
  it to `sf cancel` over stdin, exercising the full route through real entrypoints; the daemon's verifier is the
  one the bootstrap artifact carried. The control component suite covers missing, wrong, and correct credentials
  against a provisioned verifier; the entrypoint and smoke suites drive `sf cancel` over a pipe.
- **The audit-event question: no event.** Retrieval changes no bounty state — the credential was already valid
  from provisioning — so there is nothing for a projection to record. The handler logs the retrieval itself with
  `bounty_id` and `vm_id`, which is what makes the bearer middleware's `api_token_id` annotation land somewhere:
  annotations attach to logs a handler emits, and with no access-log middleware a silent handler would have left
  no record of who took operator authority. A public event would be noise on every client's timeline
  and still a partial record: the local `sf` commands that _use_ the credential run on the VM, invisible to Bebop,
  so the stream would overstate how complete the audit is. The record of operator authority is the token auth,
  not an event. Recorded in
  [Workflow actions have role-aware adapters (ADR 0038)](../../../docs/adr/0038-workflow-actions-have-role-aware-adapters.md).

`docs/capabilities/01`, `05`, `13`, and `14` and the README were corrected where they described the narrower
intent.

Blocks [What does the cockpit tell an operator to do once `sf takeover` demands a credential?](../issues/cockpit-guidance-for-operator-authenticated-commands.md).

## Comments

Filed as a `type: task` issue and re-homed here after it shipped, which is why it records **What shipped**
rather than carrying **Done when** — the acceptance criteria are the Scope bullets it was built against. The
mismatch between what this ticket delivered and the home it sat in is what prompted tightening the task/brief
discriminator in [the tracker doc](../../../.agents/ISSUE-TRACKER.md#file-formats).
