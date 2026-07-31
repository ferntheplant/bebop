# Flaky gates are not auto-retried

A gate that fails stays failed until a human runs `retry <stage>`, which extends only the exhausted constraint.
Nothing in Swordfish re-runs a gate on its own hoping for a better result.

Automatic retries would hide exactly the flakiness the constraint ledger exists to surface. A gate that passes
one time in three is a defect in the repository's verification, and a bounty that quietly burns three attempts
reaching `ready` reports success while concealing it.

## Consequences

Flakiness shows up as human interruption, which is the cost that gets it fixed.
