# Evidence

The answer to "how do I know this actually works?" Every gate a candidate passes leaves artifacts behind, tied
to the exact commit and spec revision they describe, and they survive the VM that produced them.

## What you can expect

- **Evidence bound to a commit and runtime.** A bundle names its bounty, spec revision, candidate SHA, stage, and
  runtime manifest, plus stage-specific tool versions. The runtime manifest resolves to the exact image and
  Swordfish release, including its OpenCode bill of materials. An artifact that cannot say which commit and
  environment it describes is not evidence.
- **Everything a gate produced**: validator logs, CI results, review findings, QA scenario outcomes, screenshots,
  and recordings.
- **Uploaded before readiness is claimed**, and off the VM — so destroying a bounty's computer does not destroy
  the record of what it proved.
- **Retrievable later.** `bebop bounty evidence <id> [--download <dir>]`, and browsable through bebop's private
  URL.
- **Published where you are already looking.** The first and only publication sink for the MVP is a GitHub PR
  comment posted at ready time: a summary plus key screenshots and links.
- **Stored content-addressed and deduplicated**, so re-uploading an identical artifact costs nothing and a
  manifest never points at content that is not there.
- **Bounded, with retention you can predict.** A bundle carries at most 500 MB of logical content across its
  referenced blobs before deduplication, so large browser recordings never enter Postgres. Bundle references
  expire 90 days after a bounty is done or destroyed; a mark-and-sweep job then deletes a blob only once no
  unexpired bundle references its hash, and unreferenced blobs get a grace period before collection. Metadata is
  kept regardless — you lose the artifact, never the record that it existed.

## Where it stands

**Designed.** The evidence route exists and reports an empty bundle list, honestly, because nothing produces
bundles yet. The blob contract, the CAS layout, and the retention rules are settled; none of it is built.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criterion **34** (Swordfish uploads commit-bound evidence to bebop).

## Decisions

- [Evidence is a filesystem CAS behind a blob contract (ADR 0018)](../adr/0018-evidence-is-a-filesystem-cas-behind-a-blob-contract.md)
  — no single-node MinIO; the interface is what keeps a move to real object storage an adapter rather than a
  migration of every caller. Uploads publish blobs durably before committing the manifest.
- [Bebop owns authority, Swordfish owns the loop (ADR 0002)](../adr/0002-bebop-owns-authority-swordfish-owns-the-loop.md)
  — evidence metadata and external publication are bebop's; the sandbox never receives publication credentials.
- [The master runs on exe.dev (ADR 0019)](../adr/0019-the-master-runs-on-exe-dev-with-mandatory-off-vm-backups.md)
  — the artifact volume is in the nightly off-VM snapshot.
- [The runtime manifest is the bounty software release unit (ADR 0035)](../adr/0035-the-runtime-manifest-is-the-bounty-software-release-unit.md)
  — one durable identity names the coupled software environment that produced a bundle.

Structured stage results ride the protocol's `gate_completed` event so ein gets feedback promptly; the evidence
bundle is the durable archive, not the feedback channel.

## Still open

- [Where does evidence surface, and what does a human actually read?](../../.scratch/bebop-mvp/issues/16-where-evidence-surfaces-first.md)
