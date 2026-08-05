# Provisioning and attachment

Every bounty gets its own computer, built fresh from a runtime manifest, and you get a way in. The point of
a whole VM per bounty is that it is disposable: the bounty can be destroyed without leaving residue, and nothing
it does can reach another bounty.

## What you can expect

- **A fresh VM per bounty**, from a runtime manifest naming the exact image digest and Swordfish release. That
  release pins OpenCode and the bebop plugin as internal dependencies alongside tmux, Playwright browsers, and
  common runtimes.
- **The assigned branch** `bounty/<bounty-id>` created before the VM needs it.
- **Integrations attached, credentials not.** The VM receives a repository-scoped GitHub integration, model
  access through exe.dev's LLM integration, and whichever context integrations you selected — but no reusable
  secret you could read off the machine.
- **Setup you can watch.** Repository clone and `.bebop/setup/primary` run at provision time, and their progress
  is visible in bounty status rather than being dead air.
- **Attachment metadata returned to you**: an SSH target and private preview URLs, recorded against the bounty so
  a later client can ask for them again.
- **Ein's seat up and ready**, with its configured context MCPs available. Jet and faye receive fresh seats only
  when their attempts begin.
- **A scoped operator credential**, derived per bounty and retrievable only by an authenticated Bebop client.
  Swordfish receives a salted verifier; the plaintext appears only when the operator explicitly retrieves it and
  enters it at a hidden `sf` prompt, never in VM configuration, logs, or attachment metadata. Bebop can rotate a
  lost or exposed credential.
- Previews are always private. You authenticate through exe.dev; nothing is published to the internet.

## Where it stands

**Designed.** The real provisioning path does not exist yet — bebop runs against a fake lifecycle provider. The
exe.dev API surface, the credential paths for each seat, and the compute profiles are all open questions with
tickets on the map, and three of them are blocked on having a real account to test against.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **2** (one VM and the assigned branch), **3** (only the
configured integrations; OpenCode Go through its credential-injecting proxy), **4** (SSH and preview metadata
returned), and **7** (ein's seat running with its context MCPs).

## Decisions

- [The VM is the sandbox (ADR 0012)](../adr/0012-the-vm-is-the-sandbox.md) — isolation is the computer, not the
  harness, which is why ein runs allow-all inside it.
- [Swordfish tokens are bounty-scoped (ADR 0014)](../adr/0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md)
  — minted at provisioning, never rotated, derived so a retry is stable.
- [Swordfish connects outbound only (ADR 0013)](../adr/0013-swordfish-connects-outbound-only.md) — a bounty VM
  needs no reachable address.
- [The master runs on exe.dev (ADR 0019)](../adr/0019-the-master-runs-on-exe-dev-with-mandatory-off-vm-backups.md)
  — convenience today, deployment-neutral seams, and when to leave.
- [The runtime manifest is the bounty software release unit (ADR 0035)](../adr/0035-the-runtime-manifest-is-the-bounty-software-release-unit.md)
  — why OpenCode is qualified and changed with Swordfish rather than overridden inside a live bounty.
- [Workflow actions have role-aware adapters (ADR 0038)](../adr/0038-workflow-actions-have-role-aware-adapters.md)
  — why mutating local `sf` commands need a credential that cowboys never receive.

## Still open

- Should `BEBOP_LOCAL_HARNESS_ROOT` be impossible in production rather than merely warned about?
- Provision exe.dev access and record where its credentials live
- What does exe.dev's provisioning API actually offer, and where does it fail?
- Can the exe.dev LLM integration serve ein and jet through the connected ChatGPT subscription?
- Can the exe.dev HTTP Proxy serve OpenCode Go to faye with an injected credential?
