# Every commit invalidates every downstream result

Gate outcomes are bound to both the candidate SHA and the effective-spec revision. A new commit clears every gate
result and every readiness claim — validators, CI, review, and QA all re-run. What a cowboy's verdict carries,
and what becomes of its notes, is
[Cowboys accept or reject, and a rejection carries notes (ADR 0050)](./0050-cowboys-accept-or-reject-and-a-rejection-carries-notes.md).

Partial invalidation would need a dependency model of which gate each diff could possibly affect, and being wrong
once means merging code that was reviewed in a state that no longer exists.

## Consequences

Revision loops are expensive by construction, which is the intended pressure: it is cheaper to fix everything a
round surfaced than to push a one-line change per note.
