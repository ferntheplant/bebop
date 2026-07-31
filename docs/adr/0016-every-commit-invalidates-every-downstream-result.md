# Every commit invalidates every downstream result

Gate outcomes are bound to both the candidate SHA and the effective-spec revision. A new commit clears every gate result and every readiness claim — validators, CI, review, and QA all re-run — and only findings marked `blocking` stop a candidate; non-blocking findings ride along in the evidence bundle and a PR comment at ready time.

Partial invalidation would need a dependency model of which gate each diff could possibly affect, and being wrong once means merging code that was reviewed in a state that no longer exists.

## Consequences

Revision loops are expensive by construction, which is the intended pressure: it is cheaper to fix everything a round surfaced than to push a one-line change per finding.

Flaky gates are not auto-retried. A human runs `retry <stage>`, which extends only the exhausted constraint — automatic retries would hide the flakiness that the constraint ledger exists to surface.
