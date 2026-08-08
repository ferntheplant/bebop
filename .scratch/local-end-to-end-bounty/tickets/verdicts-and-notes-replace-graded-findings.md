---
type: build
status: open
---

# The contract carries verdicts and notes, not graded findings

Resolving this updates [Code review](../../../docs/capabilities/09-code-review.md), [QA](../../../docs/capabilities/10-qa.md).

## Background

[Cowboys accept or reject, and a rejection carries notes (ADR 0050)](../../../docs/adr/0050-cowboys-accept-or-reject-and-a-rejection-carries-notes.md)
replaced per-item severity with a binary verdict, and the docs now describe that model. The shipped contract
still describes the old one, so the repository speaks two dialects until this lands.

Nothing derives a gate outcome from findings today, so no behaviour is wrong — this is a rename plus a shape
change ahead of the first code that consumes either.

## Scope

- `ReviewFinding` becomes a note: a markdown body, optional `file` and `line`, optional
  `artifacts: EvidenceArtifactPath[]`. No `severity`, no `title`, no `id` — position within a verdict is
  identity enough, and `ReviewFindingId` goes with it if nothing else uses it.
- One shared verdict shape, `{ decision: "accept" | "reject", notes }`, carried by both the review and QA gates.
  QA keeps its scenarios as an additional field; faye's `decision` is derived from them rather than supplied
  alongside, so a QA verdict that disagrees with its own scenarios must be undecodable rather than merely
  unlikely.
- A rejection with an empty `notes` array is not a valid verdict. It consumes an attempt and re-prompts the same
  seat, which is a new case beside the existing `UnstructuredFeedback` reasons rather than one of them — that
  union covers an attempt that collapsed, and this is a result that arrived and was inadequate.
- Swordfish's `findings` table becomes `notes`, with a migration.
- The `review_findings` evidence kind becomes `review_notes`.
- Golden protocol encodings and the workflow tests that assert `severity: "blocking"` move to the new shape.

## Done when

- A review gate result carries a verdict and its notes end to end, decoded at every seam it crosses.
- A rejection with no notes is refused at the schema, and the refusal is a distinct, testable case from an
  attempt that produced nothing at all.
- A QA verdict whose `decision` contradicts its scenarios cannot be constructed.
- Nothing in `packages/` or `apps/` still says `finding`, `severity`, `blocking`, or `non_blocking`.
- `vp run ready` passes.
