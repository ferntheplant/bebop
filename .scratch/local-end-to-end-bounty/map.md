# One bounty, end to end, locally

Label: `wayfinder:map`

## Destination

One real bounty runs the whole loop on a developer's own machine and produces a pull request its author can
read, trust, and merge by hand.

Concretely: the operator creates a bounty locally and attaches to a cockpit; talks to ein until the task is
clear; `/set-spec` and `/handoff` transfer control to Swordfish; Swordfish drives ein autonomously, runs
repository validators from a clean-room worktree at the exact SHA, pushes the candidate, opens a draft pull
request, waits for CI, activates jet for review and then faye for QA in a clean environment, routes findings
back to ein, enforces the constraint profile, and uploads commit-bound evidence that surfaces where a human
will actually read it. The operator can take over any cowboy at any point and hand the stage back. Then they
merge the PR themselves, on GitHub, with their own hands.

No exe.dev. No provisioned computer. No deployed master stack. A real repository, a real model, real GitHub,
and a laptop.

**Against [`ABSTRACT.md`](../../ABSTRACT.md) §8**, this destination is criteria 1, 6–37, 40, and 42, plus the
branch half of 2 and a local-attachment reading of 5. It excludes 3, 4, 38, 41, and the VM halves of 2 and 5 —
those need a provisioned computer — and 39, because merging stays in the operator's hands for now.

## Notes

**Domain:** remote supervised coding agents. Read [`ABSTRACT.md`](../../ABSTRACT.md) and
[`CONTEXT.md`](../../CONTEXT.md) before taking a ticket; check [`docs/adr/`](../../docs/adr/) before proposing
anything that contradicts a recorded decision.

**Skills every session should consult:** `/domain-modeling` when a term is in play, `/codebase-design` when a
seam is in play, `/grilling` by default.

**The destination here is a working loop, not an agreed plan.** So expect this map to be short-lived relative
to its project: the moment a decision makes a PR-sized slice specifiable, write the `build` ticket and let the
map be done with that area. Build tickets are not charted here — they sit in `tickets/` alongside the decisions
and are found by scanning, not by reading this file.

**Local is not a reduction in trust boundaries.** Running on a laptop removes the VM, but it does not repeal
[Bebop owns authority, Swordfish owns the loop (ADR 0002)](../../docs/adr/0002-bebop-owns-authority-swordfish-owns-the-loop.md)
or [The VM is the sandbox (ADR 0012)](../../docs/adr/0012-the-vm-is-the-sandbox.md). What it does is make the
seam cheap to get wrong invisibly, because both sides run as the same user on the same disk. Where a ticket
here would collapse a seam that exists for the remote case, say so and take the cost deliberately — the
remainder is meant to be a deployment, not a rewrite.

**Standing preferences:**

- Prefer a prototype to an argument. Several decisions on the old map were settled by a runnable probe under
  [`prototypes/`](../../prototypes/), and each one changed the design in a way the discussion had not.
- Anything hard to reverse, surprising, and genuinely traded off gets an ADR when it resolves. Most resolutions
  won't qualify.
- [`docs/capabilities/`](../../docs/capabilities/) says what each area is meant to do and where it stands.
  Treat a provisional value there as a starting position, not an answer.

## Decisions so far

<!-- one line per decision not yet absorbed into an ADR, capability, or gotcha -->

The control model, the lease, the `sf` surface, the cockpit layout, the constraint ledger, and the OpenCode pin
are all settled and live in ADRs 0009–0012 and 0034–0043. The local process floor — packed Bebop and Swordfish
peers over loopback with disposable Postgres — is maintained at `test/local-system/` and documented in
[`docs/testing.md`](../../docs/testing.md). That floor is what this map builds the loop on top of.

What the local loop actually assembles is settled in
[The local loop runs the production assembly (ADR 0046)](../../docs/adr/0046-the-local-loop-runs-the-production-assembly.md)
— both peers, operator-run, entrypoint-only divergence, and the two GitHub identities — and commit provenance in
[Commits carry one machine identity (ADR 0047)](../../docs/adr/0047-commits-carry-one-machine-identity.md). Four
build tickets fall out of it, and their GitHub gate is now clear. Bebop's App is provisioned and installed on the
local target, with a ruleset that refuses even the operator's own push;
[`README.md`](../../README.md#bebops-github-app) records where its credentials live, and
[The merge target must enforce rulesets (ADR 0034)](../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md)
now carries the permission set, established against the live installation.

## Not yet specified

- **What ein is actually told.** Prompt construction, spec restatement after compaction, how stage feedback is
  presented, and what a re-prompt says to an idle seat. Nothing here is decided, and it is probably the single
  biggest determinant of whether the loop works. This is the largest patch of fog on the map.
- **Driving OpenCode in production.** The workflow core and the constraint ledger are built and tested, but no
  cowboy has started an attempt outside a test — there is no production producer of OpenCode events yet. What
  the driver must observe, and what it does with an event it does not recognise, is unsettled.
- **Repository configuration in practice.** `.bebop/config.yml`, the setup and hook contracts, and the
  clean-room worktree are designed but have never run against a real repository. Hooks that hang, services that
  never become healthy, ports that collide — the failure modes will decide how much of the contract changes.
  The constraint profile is the readiest piece: the schema and the ledger enforcing it are built, so what is
  missing is only where the value is parsed from.
- **faye's browser stack, locally.** Playwright in-image was the provisional answer when there was an image. On
  a laptop, what faye drives and what a private preview even means are both open.
- **Which credentials the seats use locally, and how they are kept out of the worktree.** ein, jet, and faye
  each need a model. The exe.dev integrations that were going to deliver them are in the remainder, so the
  local answer is the operator's own credentials — which is a smaller problem, but not a solved one.

## Out of scope

- **Anything needing a provisioned computer** — exe.dev, the deployed master stack, integration attachment,
  attachment metadata, deprovisioning. That is [the MVP remainder](../mvp-remainder/map.md).
- **bebop-authorized merge.** The operator merges by hand here. Merge authority, protected-branch enforcement,
  and the readiness re-verification that guards them belong to the remainder.
- **Reliability against infrastructure loss** — backups, blue/green, VM-loss recovery, orphan sweeps. Process
  restart and event replay are in scope, because they already are; losing a computer is not.
- **Large projects, extended crew, rich clients, and task-system integrations** — unchanged from
  [`ABSTRACT.md`](../../ABSTRACT.md) §5.
