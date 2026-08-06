---
type: grilling
status: open
---

# Does the local loop run bebop as a second process, or does Swordfish take GitHub and evidence directly?

Resolving this updates [Bounty lifecycle](../../../docs/capabilities/01-bounty-lifecycle.md), [Pull request and merge](../../../docs/capabilities/12-pull-request-and-merge.md), [Evidence](../../../docs/capabilities/11-evidence.md).

## Question

[The destination](../map.md) is one bounty end to end on a laptop, ending in a pull request the operator merges
by hand. Most of that loop is Swordfish's: it drives seats, runs validators in clean-room worktrees, sequences
CI, review, and QA, and owns the constraint ledger. But three things the destination needs are bebop's under
[Bebop owns authority, Swordfish owns the loop (ADR 0002)](../../../docs/adr/0002-bebop-owns-authority-swordfish-owns-the-loop.md):
pull-request creation, evidence ingestion, and durable bounty metadata.

That split exists because the sandbox is untrusted. On a laptop there is no sandbox — Swordfish, bebop, the
seats, and the operator are the same user on the same disk, and any credential either process holds is readable
by the other. The seam is still _drawable_, but locally it protects nothing.

So the question is what the local loop actually runs, and it has three plausible answers with very different
costs:

- **Both processes, unchanged.** bebop API and worker over loopback against local Postgres, exactly as
  `test/local-system/` already runs them, with the fake lifecycle provider standing in for exe.dev. The seam
  stays exercised every day, so the remainder becomes a deployment rather than a rewrite. The cost is that the
  operator runs Postgres and two more processes to get one PR out of their own laptop, and every local failure
  has two places to look.
- **Swordfish alone, taking GitHub and evidence itself.** One daemon, one SQLite file, no Postgres, no
  loopback. Much cheaper to run and to debug. The cost is that pull-request creation and evidence ingestion get
  written on the wrong side of ADR 0002 and have to move later — and "move later" is the thing
  [`ABSTRACT.md`](../../../ABSTRACT.md) §3.10 warns about, because every caller written against the local
  shape encodes it.
- **Both processes, but bebop reduced.** bebop stays the authority for GitHub and evidence but drops Postgres
  and the worker locally, running as a single process against SQLite or a file-backed store. Cheapest thing
  that keeps the seam honest — if the persistence layer tolerates it, which is a claim about
  `packages/persistence`, not a preference.

Settle:

- which of the three the local loop runs, and what specifically decides it — operator ergonomics, the cost of
  moving code across the seam later, or the risk of the seam rotting while unexercised;
- if bebop stays, whether the operator runs it themselves or Swordfish supervises it, and what "bebop is not
  running" looks like from the cockpit at the moment a candidate is ready to push;
- where the GitHub credential lives locally, given that
  [The merge target must enforce rulesets (ADR 0034)](../../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md)
  found that pushing and merging need the same `contents: write` and so cannot be separated by permission —
  and that locally the operator merges by hand, so bebop needs push and PR rights but not merge rights;
- whether the local answer is a configuration of the production system or a genuinely different assembly, and
  if the latter, what stops the two from diverging;
- what the fake lifecycle provider means when the "VM" is the operator's own working copy — specifically
  whether it keeps creating deterministic local records or the local loop needs a different honest answer, per
  [`ABSTRACT.md`](../../../ABSTRACT.md) §3.10.

This is the first ticket on the map. Nearly every build ticket that follows depends on knowing which processes
exist and which one holds the GitHub credential.
