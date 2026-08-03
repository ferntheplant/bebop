# CI gates cowboy review

External CI must pass before Swordfish activates jet. The candidate first passes local validation, is pushed,
and receives a polled CI result; only then does it become a validated candidate, consume one slot from the
effective spec's allowance, and enter independent cowboy review. Faye still runs only after both CI and review
have passed.

The previous design ran CI and jet in parallel to reduce wall-clock latency. That spends model turns reviewing a
candidate which deterministic external checks may already reject. For the MVP, conserving cowboy work and
making the validated-candidate allowance describe SHAs that reached human-like review is worth waiting for CI.

## Consequences

A clean CI failure returns feedback to ein within the same build cycle. It consumes the ein attempt that
produced the candidate but no validated-candidate slot, and jet is never activated for that SHA. An uncertain or
explicitly rerun external CI operation remains Bebop/GitHub-side authority; Swordfish does not hide CI flakiness
with autonomous retries.

The draft pull request still appears early enough to trigger CI. The event and projection model must represent
CI completion before review activation rather than joining two parallel gates, and tests must prove that no jet
seat starts for a candidate whose CI has not passed.
