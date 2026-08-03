# Flaky gates are not auto-retried

A gate that fails stays failed until a human runs `rerun <gate>`. Rerun preserves the candidate, invalidates that
gate and every downstream gate, and starts a fresh local operation or cowboy seat. Nothing in Swordfish reruns a
gate on its own hoping for a better result; constraint exhaustion is resumed separately and extends only the
chosen exhausted constraint.

Automatic retries would hide exactly the flakiness the constraint ledger exists to surface. A gate that passes
one time in three is a defect in the repository's verification, and a bounty that quietly burns three attempts
reaching `ready` reports success while concealing it.

## Consequences

Flakiness shows up as human interruption, which is the cost that gets it fixed.
