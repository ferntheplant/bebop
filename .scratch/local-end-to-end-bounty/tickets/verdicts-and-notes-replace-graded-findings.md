---
type: build
status: open
---

# The contract speaks the settled vocabulary: verdicts, notes, gates, cowboys

Resolving this updates [Code review](../../../docs/capabilities/09-code-review.md), [QA](../../../docs/capabilities/10-qa.md).

## Background

Two decisions landed as documentation ahead of the code, deliberately, and the contract still describes the model
they replaced:

- [Cowboys approve or reject, and a rejection carries notes (ADR 0050)](../../../docs/adr/0050-cowboys-approve-or-reject-and-a-rejection-carries-notes.md)
  replaced per-item severity with a binary verdict plus notes.
- [A gate judges, a stage locates, an assignment bounds (ADR 0051)](../../../docs/adr/0051-a-gate-judges-a-stage-locates-an-assignment-bounds.md)
  separated three concepts two words were carrying, made `approve`/`reject` the outcome of every gate, made
  `succeeded`/`failed` the outcome of bounded work, freed `errored` for system breakage, and retired `agent` in
  favour of `cowboy`.

Nothing derives a gate outcome from findings today, so no behaviour is wrong — only the vocabulary is. Both land
together because renaming `ReviewFinding` twice would be silly.

## Scope

**Verdicts and notes**

- `ReviewFinding` becomes a note: a markdown body, optional `file` and `line`, optional
  `artifacts: EvidenceArtifactPath[]`. No `severity`, no `title`, no `id` — position within a verdict is identity
  enough, and `ReviewFindingId` goes with it if nothing else uses it.
- One shared verdict shape, `{ decision: "approve" | "reject", notes }`, carried by both the review and QA gates.
  QA keeps its scenarios as an additional field; faye's `decision` is derived from them rather than supplied
  alongside, so a QA verdict that disagrees with its own scenarios must be undecodable rather than merely
  unlikely.
- A rejection with an empty `notes` array is not a valid verdict. It consumes an attempt and re-prompts the same
  seat — a new case beside the existing `UnstructuredFeedback` reasons rather than one of them, since that union
  covers an attempt that collapsed and this is a result that arrived and was inadequate.
- Swordfish's `findings` table becomes `notes`, with a migration.
- The `review_findings` evidence kind becomes `review_notes`.

**Gates, stages, and outcomes**

- `verificationStages` collapses into `candidateGates`, which loses `evidence_upload` — four members, one list.
  Whatever tracks that evidence landed before `ready` must not be a gate outcome.
- `gateStatuses` becomes `not_started | pending | approved | rejected`, and `GateOutcome` is derived from it
  rather than declared as a second list that happens to agree.
- The `failed` member of `swordfishStages` and of `bountyStatuses` becomes `errored`.
- `attemptOutcomes` becomes `succeeded | failed`, with the reason (`exhausted`, `no_result`) carried beside the
  outcome rather than flattened into it — the reducer must still be able to refuse an `exhausted` claim its own
  accounting cannot support, which needs exhaustion to stay a distinct, verifiable reason.
- `ConstraintScope` is the **assignment**. Its `building | review | qa` members stay: they name the work rather
  than the worker, and their reset rules already differ by assignment rather than by cowboy.
- `agentDispositions` becomes `cowboyDispositions`; `agent_blocked` becomes `cowboy_blocked`;
  `agent_produced_no_output` and `agent_output_failed_schema_validation` take the same treatment.
- `stage_aborted_before_output` and `stage_infrastructure_failure` become `gate_`-prefixed.
- `rerunTargets` is deliberately unchanged — it names constraint scopes plus one deterministic re-execution, not
  gates. Do not "align" it.

## Done when

- A review gate result carries a verdict and its notes end to end, decoded at every seam it crosses.
- A rejection with no notes is refused at the schema, and that refusal is a distinct, testable case from an
  attempt that produced nothing at all.
- A QA verdict whose `decision` contradicts its scenarios cannot be constructed.
- Nothing in `packages/` or `apps/` still says `finding`, `severity`, `blocking`, `non_blocking`, or `agent` as a
  word for a cowboy; no gate reports `passed` or `failed`; nothing terminal reports `failed` where it means a
  system error.
- Golden protocol encodings and the persisted event history migrate, or the migration path is stated and tested.
- `vp run ready` passes.
