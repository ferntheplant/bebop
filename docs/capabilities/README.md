# Capabilities

What Bebop does for the person using it, one capability per file — first the thirteen a bounty passes through in
order, then the two that hold across all of them.

This is the catalogue of what the system is **for**. [`ABSTRACT.md`](../../ABSTRACT.md) says what Bebop is in one
page and holds the 42 acceptance criteria; this directory says what each capability delivers, where it stands,
and which of those criteria prove it. Every criterion in `ABSTRACT.md` §8 is owned by exactly one capability, so
a criterion nobody claims is a visible gap rather than a silent one.

| #   | Capability                                                         | Stands at        | §8 criteria            |
| --- | ------------------------------------------------------------------ | ---------------- | ---------------------- |
| 1   | [Bounty lifecycle](./01-bounty-lifecycle.md)                       | Partial          | 1, 41                  |
| 2   | [Provisioning and attachment](./02-provisioning-and-attachment.md) | Designed         | 2, 3, 4, 7             |
| 3   | [The cockpit](./03-the-cockpit.md)                                 | Designed         | 5, 6                   |
| 4   | [The effective-spec handoff](./04-the-effective-spec-handoff.md)   | Designed         | 8, 9, 10, 11           |
| 5   | [Control lease and takeover](./05-control-lease-and-takeover.md)   | Partial          | 12, 13, 31, 32, 33     |
| 6   | [Autonomous implementation](./06-autonomous-implementation.md)     | Partial          | 14, 15, 16, 23, 24, 28 |
| 7   | [Repository configuration](./07-repository-configuration.md)       | Designed         | 19                     |
| 8   | [Local validation](./08-local-validation.md)                       | Designed         | 17, 18                 |
| 9   | [Code review](./09-code-review.md)                                 | Designed         | 22                     |
| 10  | [QA](./10-qa.md)                                                   | Designed         | 25, 26, 27             |
| 11  | [Evidence](./11-evidence.md)                                       | Designed         | 34                     |
| 12  | [Pull request and merge](./12-pull-request-and-merge.md)           | Refuses honestly | 20, 21, 35–39          |
| 13  | [Recovery and reliability](./13-recovery-and-reliability.md)       | Partial          | 29, 30, 40, 42         |
| 14  | [The security model](./14-the-security-model.md)                   | Designed         | none — see below       |
| 15  | [Deployment and operation](./15-deployment-and-operation.md)       | Designed         | none — see below       |

Capabilities 14 and 15 own no acceptance criterion, because both are properties of the whole system rather than
stages with their own test. That is worth knowing rather than fixing: **nothing in `ABSTRACT.md` §8 fails if the
security model is violated or the deployment is unbacked-up.** Release qualification is the open question that
should close that gap, and it is still fog on [the map](../../.scratch/bebop-mvp/map.md).

**Stands at** means:

- **Built** — reachable through a real entrypoint and covered by tests.
- **Partial** — some of it runs today; each file names what is missing.
- **Designed** — decided and written down, no production path yet.
- **Refuses honestly** — the route exists and returns a refusal rather than a plausible success, per
  [`ABSTRACT.md`](../../ABSTRACT.md) §3.10.

## What belongs here

Descriptive behaviour, in the vocabulary of [`CONTEXT.md`](../../CONTEXT.md). A capability file says what a user
can expect and points at the decisions that shaped it — it does not restate them. If you are writing something
that is really a decision, it belongs in [`docs/adr/`](../adr/); a term belongs in `CONTEXT.md`; an open question
belongs on [the map](../../.scratch/bebop-mvp/map.md).

These files carry provisional answers as well as settled ones — a default nobody has reviewed is still the
starting position a session has to react to. Where a value is provisional and its question is live, the
capability says so and links the ticket.
