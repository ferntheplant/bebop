# Provisioning and attachment

Every bounty gets its own computer, built fresh from a versioned base image, and you get a way in. The point of
a whole VM per bounty is that it is disposable: the bounty can be destroyed without leaving residue, and nothing
it does can reach another bounty.

## What you can expect

- **A fresh VM per bounty**, from a pinned base image carrying OpenCode and the bebop plugin, Swordfish, tmux,
  Playwright browsers, and common runtimes.
- **The assigned branch** `bounty/<bounty-id>` created before the VM needs it.
- **Integrations attached, credentials not.** The VM receives a repository-scoped GitHub integration, model
  access through exe.dev's LLM integration, and whichever context integrations you selected — but no reusable
  secret you could read off the machine.
- **Setup you can watch.** Repository clone and `.bebop/setup/primary` run at provision time, and their progress
  is visible in bounty status rather than being dead air.
- **Attachment metadata returned to you**: an SSH target and private preview URLs, recorded against the bounty so
  a later client can ask for them again.
- **Seats up and ready**, with ein's configured context MCPs available in its session.
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

## Still open

- [Provision exe.dev access and record where its credentials live](../../.scratch/bebop-mvp/issues/03-provision-exe-dev-access.md)
- [What does exe.dev's provisioning API actually offer, and where does it fail?](../../.scratch/bebop-mvp/issues/04-exe-dev-provisioning-api-surface.md)
- [Can the exe.dev LLM integration serve ein and jet through the connected ChatGPT subscription?](../../.scratch/bebop-mvp/issues/01-exe-dev-llm-integration-for-ein-and-jet.md)
- [Can the exe.dev HTTP Proxy serve OpenCode Go to faye with an injected credential?](../../.scratch/bebop-mvp/issues/02-exe-dev-http-proxy-for-opencode-go.md)
- [How is the OpenCode pin enforced, and what qualifies an upgrade?](../../.scratch/bebop-mvp/issues/14-opencode-version-pin-and-upgrade-qualification.md)
