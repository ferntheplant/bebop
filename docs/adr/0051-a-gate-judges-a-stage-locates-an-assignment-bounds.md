# A gate judges, a stage locates, an assignment bounds

Three concepts were sharing two words. A **gate** is one of the four points where a candidate can be stopped: local validation, external CI, jet's review, faye's QA. A **stage** is a position in the state machine Swordfish and bebop use to track progress — `implementing`, `qa_preparing`, `needs_attention`, `cancelling`. An **assignment** is the bounded piece of autonomous work a cowboy is given, and the thing an attempt allowance is spent from: `building` for ein, `review` for jet, `qa` for faye.

The collisions were real and in binding documents. `verificationStages` named gates; [Readiness is a claim (ADR 0003)](./0003-readiness-is-a-claim-not-authority.md) said "Swordfish's required stages passed for it" meaning gates; `CONTEXT.md` defined stage as a workflow position. Meanwhile the assignment had no name at all outside a code comment on `ConstraintScope`, even though `CONTEXT.md` reached for the word twice in prose — "one stage assignment", "attempts per cowboy assignment" — without ever defining it. A term that names both a checkpoint and a location can be used precisely as neither, and a concept the glossary keeps naming by accident is one the glossary is missing.

The three stay distinct because they cut differently. For jet and faye an assignment lines up with a gate, but ein has an assignment and no gate — ein is not a checkpoint. Several stages judge nothing and bound nothing. Collapsing any pair would encode a coincidence.

## Every gate approves or rejects

Previously the deterministic gates passed or failed while cowboys accepted or rejected, so a reader had to know which gate produced an outcome before knowing which verb described it. That distinction was never real: a validator exiting non-zero and jet writing a rejection are the same event — this candidate may not proceed. `passed` / `failed` named the mechanism, and the mechanism is exactly the part that differs between a shell exit code and a model's judgement. What all four share is the consequence, so the consequence is what the vocabulary names. **Accept** is retired for **approve**, giving one pair of words for all four gates.

`evidence_upload` is therefore not a gate. It judges nothing, its only legal feedback is `unstructured`, and it cannot stop a candidate on merit — it can only break. It stays a stage, and something other than a gate outcome must record that evidence landed before a bounty reaches `ready`.

## Bounded work succeeds or fails

An assignment and an attempt **succeed** or **fail**, and failure means the work did not produce what it was for. Running out of an allowance is the most common reason but not the only one: a cowboy that finishes without handing back a usable result has failed its attempt without exhausting anything. The reason stays recorded beside the outcome, because [Constraint exhaustion is computed, not announced (ADR 0042)](./0042-constraint-exhaustion-is-computed-not-announced.md) has the reducer refuse an `exhausted` claim its own accounting cannot support — a check that only works while exhaustion is a distinct, verifiable reason rather than a synonym for failure.

This is a different axis from a gate's verdict, and keeping them apart resolves the case that reads as a contradiction under one vocabulary: **jet's attempt can succeed while its gate rejects.** The reviewer did exactly its job, and the answer was no.

Allowances nest, three deep, and each level fails by exhaustion in the same sense: validated candidates per effective spec, attempts per assignment, turns and wall clock per attempt. They are **allowances**, deliberately not "cycles" — a **build cycle** is already one specific span of ein's work, and a generic use of the word would collide with it on sight.

None of these failures is terminal. Exhausting an allowance raises `constraint_exhausted` and asks a human, who may `continue` the attempt or `rerun` the assignment ([Continue preserves an attempt; rerun replaces it (ADR 0041)](./0041-continue-preserves-an-attempt-rerun-replaces-it.md)). "The assignment failed" means work stopped and somebody is being asked, not that the bounty is over.

An attempt is spent when the cowboy **hands something back** — a completion, an exhausted watchdog, or a result the gate could not use, such as the notes-less rejection [Cowboys approve or reject, and a rejection carries notes (ADR 0050)](./0050-cowboys-approve-or-reject-and-a-rejection-carries-notes.md) refuses. Swordfish nudging a cowboy that is still working spends nothing, which is why idle re-prompts and process restarts live inside one attempt. "Was there a re-prompt" does not separate these cases; "did the cowboy hand something back" does.

## Failed, errored, rejected

With `failed` meaning bounded work that did not deliver, terminal states that mean "something broke unexpectedly" are **errored**. A bounty and a Swordfish stage each carried a `failed` value for an unexpected system condition, which read as though something had been judged. The endings become `done` (merged), `stopped` (deliberately halted), and `errored` (something broke) — three genuinely different ways to stop rather than two and a synonym.

**Agent** is retired everywhere for **cowboy**. `CONTEXT.md` has said to avoid it since it collides with OpenCode's own vocabulary and wrongly includes deterministic Swordfish, while the contract still carried `agentDispositions`, `agent_blocked`, and two `UnstructuredFeedbackReason` members. A glossary the schema contradicts is one nobody can rely on.

## Consequences

The contract renames follow. `verificationStages` collapses into `candidateGates`, now the same four members. `gateStatuses` becomes `not_started | pending | approved | rejected`, with `GateOutcome` derived from it rather than declared as a second list that happens to agree. `attemptOutcomes` becomes `succeeded | failed` with the reason — `exhausted`, `no_result` — carried beside it. `ConstraintScope` is the assignment, and keeps its `building | review | qa` members: they name the work rather than the worker, and their reset rules already differ by assignment rather than by cowboy, so collapsing them into role names would encode "one cowboy, one assignment" into the schema. The `failed` member of `swordfishStages` and `bountyStatuses` becomes `errored`; `agentDispositions` becomes `cowboyDispositions`; `stage_aborted_before_output` and `stage_infrastructure_failure` take a `gate_` prefix.

`rerunTargets` stops being an oddity and needs no change. It is the three assignments plus `validation`: `rerun building` grants an attempt in ein's assignment, while `rerun validation` re-runs a gate and grants none. Two different kinds of thing in one list is defensible now that both words exist — and stating it here is cheaper than letting the next reader rediscover it as a collision, which is what happened while this decision was being made.

Approval spans two altitudes with two words that must not merge: a **gate** approves a candidate, and a human **approves config** under a privileged path ([`.bebop/**` is permanently privileged (ADR 0011)](./0011-the-bebop-directory-is-permanently-privileged.md)). Different acts, actors, and objects — `approve_config` keeps its own name so a gate approval can never be mistaken for authority a human granted.

This is vocabulary, not behaviour: no transition, permission, or outcome changes meaning, and the same events are recorded. It is worth an ADR anyway, because the previous names actively taught a wrong model — that deterministic gates and cowboy gates do different kinds of thing, that a checkpoint and a location are the same kind of thing, and that the work a cowboy is given has no name of its own.
