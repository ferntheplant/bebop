# Bebop MVP

Label: `wayfinder:map`

## Destination

A merged bounty. One task goes out from the local CLI to a provisioned exe.dev VM, gets implemented, verified,
reviewed, QA'd, and caught — with every acceptance criterion in [`ABSTRACT.md`](../../ABSTRACT.md) §8 passing
against an automated test, a provider smoke test, or an explicitly documented manual inspection.

The control plane exists already: bebop and Swordfish are real processes with real persistence that reconnect
safely and share one workflow core. What remains is everything that touches the outside world — real VMs, real
repositories, real models, real GitHub — and the decisions those force.

## Notes

**Domain:** remote supervised coding agents. Read [`ABSTRACT.md`](../../ABSTRACT.md) and
[`CONTEXT.md`](../../CONTEXT.md) before taking a ticket; check [`docs/adr/`](../../docs/adr/) before proposing
anything that contradicts a recorded decision.

**Skills every session should consult:** `/domain-modeling` when a term is in play, `/codebase-design` when a
seam is in play, `/grilling` by default. When a ticket's resolution has made a PR-sized slice specifiable, write
it up as a brief.

**Standing preferences:**

- Plan, don't do. Tickets here resolve decisions. When the way through an area is clear, write a brief at
  `.scratch/<feature>/brief.md` and hand off — the build is not tracked on this map.
- Prefer a prototype to an argument. Four of the decisions below were settled by a runnable probe under
  [`prototypes/`](../../prototypes/), and each one changed the design in a way the discussion had not.
- Anything hard to reverse, surprising, and genuinely traded off gets an ADR when it resolves. Most resolutions
  won't qualify — a resolution comment on the ticket is enough.
- [`docs/capabilities/`](../../docs/capabilities/) says what each area is meant to do and where it stands. Treat
  a provisional value there as a starting position, not an answer.

## Decisions so far

Entries above the line predate the map — the route was walked before it was charted, so they link ADRs and
prototypes rather than tickets.

- [The bounty primitive (ADR 0001)](../../docs/adr/0001-the-bounty-primitive.md) — one VM, one branch, at most
  one PR.
- [Bebop owns authority, Swordfish owns the loop (ADR 0002)](../../docs/adr/0002-bebop-owns-authority-swordfish-owns-the-loop.md)
  — bebop owns everything reaching outside the sandbox; Swordfish owns one bounty's delivery loop.
- [Readiness is a claim (ADR 0003)](../../docs/adr/0003-readiness-is-a-claim-not-authority.md) — bebop
  re-verifies every readiness claim against live state before offering merge.
- [Commit to OpenCode (ADR 0004)](../../docs/adr/0004-commit-to-opencode-with-no-harness-abstraction.md) — no
  harness abstraction; the plugin is a first-class module.
- [Effect on Bun (ADR 0005)](../../docs/adr/0005-effect-on-bun-for-every-process.md) — one language, one stack,
  with measured criteria for reconsidering a native Swordfish.
- [The four-layer control lease (ADR 0009)](../../docs/adr/0009-the-control-lease-is-enforced-in-four-layers.md)
  — settled by [the lease-guard prototype](../../prototypes/lease-guard/README.md), which found that the plugin
  alone cannot hold the lease: `POST /session/:id/shell` invokes no hook and `--pure` skips the plugin entirely.
- [Seat credentials die with the lease (ADR 0010)](../../docs/adr/0010-no-human-held-seat-credential-survives-a-control-release.md)
  — rotation on every control release, or the lease is advisory after the first takeover.
- [`.bebop/**` is permanently privileged (ADR 0011)](../../docs/adr/0011-the-bebop-directory-is-permanently-privileged.md)
  — SHA-pinned human approval, glob list read from base.
- [Swordfish connects outbound only (ADR 0013)](../../docs/adr/0013-swordfish-connects-outbound-only.md) — no
  inbound ingress to bebop or to a bounty VM, so CI is observed by polling.
- [Clean-room verification (ADR 0015)](../../docs/adr/0015-verification-runs-in-a-clean-room-worktree.md) and
  [full invalidation (ADR 0016)](../../docs/adr/0016-every-commit-invalidates-every-downstream-result.md) — a
  gate result is a statement about a commit, and it dies with that commit.
- [Squash-only merges (ADR 0017)](../../docs/adr/0017-squash-only-merges.md),
  [commits authored by the acting seat (ADR 0032)](../../docs/adr/0032-commits-are-authored-by-the-acting-seat.md),
  and [base drift gated on conflict (ADR 0033)](../../docs/adr/0033-base-drift-is-conflict-gated.md) — how a
  bounty reaches the target branch, and whose name is on it.
- [Evidence is a filesystem CAS (ADR 0018)](../../docs/adr/0018-evidence-is-a-filesystem-cas-behind-a-blob-contract.md)
  — no single-node MinIO.
- [tmux can lock a pane](../../prototypes/tmux-input-lock/README.md) — `select-pane -d` disables input while the
  pane keeps rendering, and the lock is clearable by any pane in the session, so it is UX and not protection.
- [Vitest is launched by Bun (ADR 0020)](../../docs/adr/0020-vitest-is-launched-by-bun.md) — no test may pass on
  a runtime production never uses.
- The persistence, transport, and packaging constraints the prototypes found are not decisions and are recorded
  in [`docs/gotchas.md`](../../docs/gotchas.md) instead.

---

<!-- resolutions from this point on link their ticket -->

- [The merge target must enforce rulesets (ADR 0034)](../../docs/adr/0034-the-merge-target-must-enforce-rulesets.md),
  from [ticket 12](./issues/12-github-app-permissions-and-branch-protection.md)
  — an installation token cannot be scoped to `bounty/*`, and merging needs the same `contents: write` the
  sandbox pushes with, so the two identities are not separable by permission. A `pull_request` rule denies
  everyone including the repository owner, and bebop merges through the PR API rather than around it, so
  `bypass_actors` stays empty. Squash-only and required checks are enforced and readable back from
  `GET /rules/branches/{branch}`, which lets bebop verify protection instead of assuming it. Two constraints
  fall out: the merge target must be public or on a paid plan, and a SHA-pinned merge only reports the
  diagnostic `409 Head branch was modified` once `mergeable` is non-null — before that it is an ambiguous `405`.

## Not yet specified

In scope, not yet sharp enough to ticket. Graduates as the frontier advances.

- **The end-to-end protocol under real failure.** Both processes exist and both reconnect, but they have never
  run as separate processes across a network that can break. What the two are supposed to guarantee each other
  is written down ([recovery and reliability](../../docs/capabilities/13-recovery-and-reliability.md)) — what
  isn't known is which failures turn out to need a decision rather than a test. Expect this patch to graduate
  into a small number of tickets and one brief.
- **Repository configuration in practice.** `.bebop/config.yml`, the setup and hook contracts, and the
  clean-room worktree are designed but have never been run against a real repository. The shape of the failure
  modes — a hook that hangs, a service that never becomes healthy, a port that collides — will decide how much
  of the contract needs to change.
- **What ein is actually told.** Prompt construction, spec restatement after compaction, how stage feedback is
  presented, and what a re-prompt says to an idle seat. Nothing here is decided, and it is probably the single
  biggest determinant of whether the loop works.
- **QA that proves something.** faye's browser stack, what a private preview looks like from inside the VM, and
  what evidence distinguishes "QA ran against the candidate" from "QA ran against something".
- **Operating a bounty fleet.** What the operator sees when six bounties are live, which failures page a human,
  and what the observability floor actually needs to contain beyond structured logs.
- **Release qualification.** What has to pass before the MVP is called done, beyond the acceptance criteria
  themselves — migration-from-previous-version, stress runs, backup restore.

## Out of scope

Ruled beyond this destination. Does not graduate; returning would mean redrawing the destination as a fresh
effort.

- **Large projects and extended crew** — multi-PR decomposition, coordinator agents, child-bounty dependency
  graphs, cross-bounty integration, durable program plans, and the reserved `spike` and `ed` roles. The bounty
  primitive is meant to be the thing these are built _from_, after real usage informs their design.
- **Rich clients** — cockpit v2 on the OpenCode web UI, a web or desktop dashboard, Herdr as an authoritative
  cockpit, mobile control, push notifications. The tmux cockpit is the MVP surface.
- **Task-system integrations** — Linear agent sessions, Sentry- or PostHog-triggered bounty creation, automatic
  task updates. All of these are machine clients of the bebop API and none of them need the API to change.
- **Additional infrastructure** — public API ingress (and therefore GitHub webhooks), warm per-repo VM
  snapshots, reviewer and QA seat reuse across revisions, cross-vendor frontier review for jet, Daytona or
  self-hosted compute, a branch-scoped Git gateway, multihost bebop, production deployment of the bounties'
  own output.
