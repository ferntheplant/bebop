# Bebop MVP

Label: `wayfinder:map`

## Destination

A merged bounty. One task goes out from the local CLI to a provisioned exe.dev VM, gets implemented, verified,
reviewed, QA'd, and caught — with every acceptance criterion in [`ABSTRACT.md`](../../ABSTRACT.md) §8 passing
against an automated test, a provider smoke test, or an explicitly documented manual inspection.

The control plane exists already: bebop and Swordfish are real processes with real persistence that reconnect
safely and share one workflow core. The orthogonal control model and its constraint ledger are built. What
remains includes the production modules that drive seats and deterministic gates, plus everything that touches
the outside world — real VMs, real repositories, real models, real GitHub — and the decisions those force.

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
  Its tmux layer was later superseded by
  [The control lease blocks mixed model turns, not trusted cockpit input (ADR 0039)](../../docs/adr/0039-the-control-lease-blocks-mixed-model-turns-not-trusted-cockpit-input.md).
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
- [The runtime manifest is the bounty software release unit (ADR 0035)](../../docs/adr/0035-the-runtime-manifest-is-the-bounty-software-release-unit.md),
  from [How is the OpenCode pin enforced, and what qualifies an upgrade?](./issues/14-opencode-version-pin-and-upgrade-qualification.md)
  — OpenCode is pinned inside an immutable Swordfish release rather than overridden independently. Every upgrade
  passes the hermetic contract suite, the candidate-image suite, and an explicit direct-provider smoke before
  merge makes that runtime manifest the default for new bounties.
- [Control passes through a quiescent handoff (ADR 0036)](../../docs/adr/0036-control-passes-through-a-quiescent-handoff.md),
  from [What is a safe point to interrupt a seat, and what does takeover do at each stage?](./issues/06-what-is-a-safe-point-to-interrupt-a-seat.md)
  — takeover claims the lease immediately but withholds human access until OpenCode aborts or the selected seat
  is forcibly restarted. It guarantees no concurrent actor, not rollback; handoff reconciles and starts fresh
  work rather than resuming an interrupted turn.
- [One controller drives one active cowboy (ADR 0037)](../../docs/adr/0037-one-controller-drives-one-active-cowboy.md)
  and [workflow actions have role-aware adapters (ADR 0038)](../../docs/adr/0038-workflow-actions-have-role-aware-adapters.md),
  from [What is the `sf` command surface, in use?](./issues/07-the-sf-command-surface.md) — stage and human control
  are orthogonal, at most one cowboy seat is active, and cowboy tools, human slash commands, and authenticated
  `sf` commands invoke one typed transition implementation. Mutating local commands require a per-bounty
  operator credential; external authority remains bebop-side.
- [The control lease blocks mixed model turns, not trusted cockpit input (ADR 0039)](../../docs/adr/0039-the-control-lease-blocks-mixed-model-turns-not-trusted-cockpit-input.md),
  from [What does the cockpit look like, and where do log panes come from?](./issues/08-cockpit-layout-and-log-panes.md)
  — attachment starts with one full-screen active seat and a workflow status line; Swordfish preserves
  operator-created tmux layout and exposes service logs as files rather than panes. The plugin blocks mixed model
  turns while unexpected shell, abort, revert, or unrevert actions are detected as intrusions.
- [CI gates cowboy review (ADR 0040)](../../docs/adr/0040-ci-gates-cowboy-review.md) and
  [Continue preserves an attempt; rerun replaces it (ADR 0041)](../../docs/adr/0041-continue-preserves-an-attempt-rerun-replaces-it.md),
  from [What are the default constraints, and what happens when one is exhausted?](./issues/09-default-constraints-and-exhaustion.md)
  — a base-revision repository profile bounds autonomous attempts and each spec's CI-passed candidates. CI now
  precedes jet; exhaustion preserves a final attempt for `continue`, while `rerun` explicitly starts another.
  Human recoveries are unlimited but authenticated and recorded.
- [Constraint exhaustion is computed, not announced (ADR 0042)](../../docs/adr/0042-constraint-exhaustion-is-computed-not-announced.md),
  from building ADRs 0036–0041 rather than from a ticket — the pure reducer accrues turns and attempt wall clock
  from event timestamps, owns the exhaustion predicate, and rejects a `constraint_exhausted` claim its own
  accounting does not support. Swordfish's existing heartbeat loop is the wake-up for the silent case, so the
  ledger adds no timer; Bebop re-verifies elapsed time as a defect signal about the daemon rather than as an
  exhaustion of its own.
- [Real packed Bebop and Swordfish processes compose over loopback](./issues/20-real-process-local-protocol.md) —
  worker-first and daemon-first startup, API and daemon restart, event replay, acknowledgement, projection, local
  cancellation, and offline command delivery all preserve one history without duplication. The probe reaches
  only `interactive` and cancellation because OpenCode events still have no production producer. It found no new
  protocol decision; it produced [the local system harness brief](../local-system-harness/brief.md) so that floor
  can become maintained before the OpenCode driver lands.
- [The local system harness is maintained](./../local-system-harness/brief.md) — the packed-process floor now lives
  at `test/local-system/` and runs via `vp run local-system`: worker-first and API-first startup, idempotent
  create with a retry-stable bootstrap identity, Swordfish-before-listener registration, API restart, daemon
  `SIGKILL`, local `sf cancel`, and an offline Bebop stop all pass repeatedly over disposable Postgres. The
  machine credential travels from Bebop derivation through `LifecycleProvider.provision` into a one-shot bootstrap
  artifact the supervisor consumes and destroys, never through an operator retrieval route. The `bebop` CLI gained
  `bounty stop`. This is the floor the OpenCode driver now consumes.
- **The operator credential is derived and provisioned; enforcing it is the next ticket.**
  [Workflow actions have role-aware adapters (ADR 0038)](../../docs/adr/0038-workflow-actions-have-role-aware-adapters.md)
  was amended on three points a grilling session settled: the credential stops a _confused_ cowboy and explicitly
  not a compromised one, since a hostile same-uid process inside the VM is already outside
  [The VM is the sandbox (ADR 0012)](../../docs/adr/0012-the-vm-is-the-sandbox.md); it is derived
  deterministically and never rotates, matching
  [Swordfish tokens are bounty-scoped (ADR 0014)](../../docs/adr/0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md);
  and the verifier is a plain SHA-256 digest, because a 256-bit derived secret has no dictionary to precompute
  and salting would cost the determinism that keeps provisioning retries stable. Bebop now derives both
  credentials in one place and the provider injects both. Nothing enforces the credential yet, deliberately:
  refusing every mutation before a human can obtain one would be worse than refusing none. The next work is
  [ticket 22](./issues/22-operator-credential-retrieval-and-enforcement.md) — retrieval route, wire field,
  enforcement, and prompt, in one change.

These seven ADRs have been built out under [the orthogonal control model](../workflow-control-model/brief.md).
Its first slice — stage, controller, and attention as independent dimensions, one active cowboy, and CI before
review — shipped first; the constraint ledger followed, adding
[A rerun resolves the kind its target names (ADR 0043)](../../docs/adr/0043-a-rerun-resolves-the-kind-its-target-names.md)
for the one edge ADR 0042 left open. What the ledger still lacks is a producer: no cowboy has yet started an
attempt outside a test, and the profile it judges against is the built-in default rather than a repository's,
which is the fog under "Repository configuration in practice" below.

## Not yet specified

In scope, not yet sharp enough to ticket. Graduates as the frontier advances.

- **Repository configuration in practice.** `.bebop/config.yml`, the setup and hook contracts, and the
  clean-room worktree are designed but have never been run against a real repository. The shape of the failure
  modes — a hook that hangs, a service that never becomes healthy, a port that collides — will decide how much
  of the contract needs to change. The constraint profile is the narrowest piece of it and the readiest: the
  schema and the ledger enforcing it are built, and a bounty freezes the profile as a value at construction, so
  what is missing is only where that value is parsed from.
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
