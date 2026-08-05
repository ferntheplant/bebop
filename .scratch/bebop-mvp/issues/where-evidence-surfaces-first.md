---
type: grilling
status: open
blocked-by: [finding-severities-and-where-they-surface]
---

# Where does evidence surface, and what does a human actually read?

Resolving this updates [Evidence](../../../docs/capabilities/11-evidence.md).

## Question

Evidence lands in a content-addressed store
([Evidence is a filesystem CAS (ADR 0018)](../../../docs/adr/0018-evidence-is-a-filesystem-cas-behind-a-blob-contract.md)) and is provisionally
published first as a GitHub PR comment, with `bounty evidence [--download]` plus private-URL browsing as the
access path ([evidence](../../../docs/capabilities/11-evidence.md)).

Settle:

- what the PR comment contains — a bundle of screenshots and validator logs pasted into a comment is unreadable,
  and a comment that is only links is unusable when the links are private;
- who can reach a private URL, and whether evidence for a merged bounty outlives the master's ingress;
- whether `bounty evidence` should stream, download, or open — and what a human reviewing a PR on a phone gets;
- what a _failed_ bounty's evidence is for, given that nothing will merge and the VM will be destroyed in seven
  days;
- whether the 90-day reference expiry is compatible with a PR comment that stays visible forever, which would
  leave dead links in the repository's history.
