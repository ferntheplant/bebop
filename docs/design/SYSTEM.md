# Bebop system design

**Descriptive, not authoritative. Where this file and the code disagree, the code wins.**

This is the area-level design detail carried over from the original `SPEC.md`: state ownership, the user and
Swordfish workflows, repository configuration, capability profiles, the cockpit, the API, the Bebop–Swordfish
protocol, source control, exe.dev, security, persistence, evidence, deployment, and the implementation stack.

It is a reference, not a plan and not a contract. Section numbers are preserved from the original `SPEC.md`
(§9–§25) so that existing references from code comments and prototype write-ups still resolve.

## This file is a quarry, not a monument

Everything here is waiting to be mined into its proper home, and the mining happens **opportunistically** — when
work touches an area, that area's content moves out and the section here is replaced by a pointer. The
destinations:

- **A capability** — descriptive behaviour a user can expect, moved into
  [`docs/capabilities/`](../capabilities/). This is where most of this file ends up.
- **Vocabulary** — a term this file defines or leans on, sharpened into [`CONTEXT.md`](../../CONTEXT.md).
- **A decision** — something hard to reverse, surprising without context, and the result of a real trade-off,
  written up as an ADR in [`docs/adr/`](../adr/). Much of §9–§25 is decision-shaped and has already been mined
  this way; what remains here is the surrounding explanation.
- **Fog** — anything still marked provisional, unverified, or "to decide", which belongs on the map at
  [`.scratch/bebop-mvp/map.md`](../../.scratch/bebop-mvp/map.md) as a ticket or as a line under Not yet
  specified.
- **A brief** — behaviour that a single PR will build, written into `.scratch/<feature>/brief.md` and kept there
  once it ships.

Do not add to this file. New design detail belongs in one of those four places from the start.

---

## 9. State ownership

State is deliberately split rather than duplicated ambiguously.

### 9.1 Bebop-authoritative state

Bebop is authoritative for:

- bounty identity;
- current VM identity;
- target repository and base ref;
- assigned branch and pull request;
- requested context capabilities;
- attachment metadata;
- lifecycle commands;
- current branch head;
- privileged-path change approvals;
- merge authorization and outcome;
- evidence object metadata;
- destruction and retention.

### 9.2 Swordfish-authoritative state

Swordfish is authoritative for:

- seat identities (role ↔ OpenCode session ID);
- current effective-spec revision;
- current inner workflow stage;
- control-lease owner;
- primary, review, and QA attempts;
- turn and wall-clock budgets;
- candidate submissions;
- local validator results;
- review findings;
- QA findings;
- local evidence staging;
- unsent bebop events.

### 9.3 Bebop status projection

Swordfish streams sequenced events and heartbeats to bebop. Bebop stores a durable projection so that `bounty list` and `bounty status` work even if the bounty VM is temporarily unreachable. The same projection backs the SSE event feed for clients.

The projection must record freshness. A disconnected Swordfish cannot be presented as currently working merely because its last event said `implementing`.

### 9.4 Readiness is a claim, not authority

Swordfish may claim that commit `X` is ready. Before exposing merge as available, bebop must independently verify:

- the assigned branch still points to `X`;
- required GitHub checks for `X` passed;
- Swordfish's required stages for `X` passed;
- the effective-spec revision matches;
- no privileged-path change remains unapproved.

## 10. User workflow

### 10.1 Create a bounty

The user runs `bebop bounty create`, which calls the bebop API.

Conceptual input (note: no harness field — OpenCode is not a parameter, it is the system):

```ts
interface CreateBountyRequest {
  repository: string;
  baseRef: string;
  computeProfile: string; // "small" | "standard" | "large"
  primaryContext: string[];
  initialPrompt?: string;
}
```

Bebop:

1. creates a bounty record;
2. creates the assigned branch `bounty/<bounty-id>`;
3. provisions an exe.dev VM from the current bebop base image;
4. attaches the repository-scoped GitHub integration;
5. attaches the exe.dev LLM and OpenCode Go HTTP-proxy integrations (§20.2);
6. attaches selected context integrations;
7. installs and starts Swordfish;
8. waits for Swordfish's authenticated connection;
9. returns attachment metadata.

Setup progress (repo clone, `.bebop/setup/primary`) is visible in bounty status while provisioning.

### 10.2 Attach

The user attaches with SSH and lands in the Swordfish-owned cockpit (§16).

### 10.3 Start work with ein

Ein's seat starts with the bounty. The user discusses and refines the task directly with ein in its pane.

### 10.4 Enter autonomous mode

The user invokes `/auto`.

The bebop OpenCode plugin instructs ein to:

1. summarize the effective task from the conversation;
2. produce the structured effective spec;
3. show it to the user;
4. revise it until the user confirms it;
5. call the Swordfish-provided `set_spec` tool.

`set_spec` atomically:

- persists a new spec revision;
- records user confirmation;
- transfers ein's control lease to Swordfish;
- revokes any seat credential issued to the user during this control episode, rotating the seat server password (§11.5);
- enters the autonomous implementation stage.

If OpenCode emits `session.idle` without `set_spec`, Swordfish re-prompts the same seat once. Repeated failure leaves the bounty interactive and marks it as needing attention. It never starts autonomous work without an effective spec.

### 10.5 Observe or take over

The user may always observe visible seat output, and may explore the VM freely from cockpit shell panes.

To steer an active agent, the user issues a cockpit takeover command. Swordfish:

1. interrupts or pauses the seat at a safe point;
2. records the takeover;
3. transfers the control lease;
4. enables input to that seat pane;
5. issues the seat credential if the user requested a second client (§11.5);
6. changes the bounty status to `human_controlled`.

When returning control:

- any seat credential issued during the control episode is revoked (§11.5);
- ein's handback checks whether the effective spec remains valid;
- implementation-only guidance may continue under the same spec revision;
- changed product behavior produces a proposed spec revision and requires confirmation;
- jet and faye handbacks return or restart their respective stage.

If the user disconnects without releasing control, Swordfish does not infer intent. The bounty remains `human_controlled`.

Human-steered review and QA results remain valid but are marked `human_steered` in their evidence provenance.

### 10.6 Merge — catching the bounty

When bebop reports `ready`, the user inspects the PR and evidence, then runs `bebop bounty merge`.

Bebop rechecks readiness for the current head, squash-merges with its own GitHub authority, marks the bounty done, and deprovisions the VM according to policy.

## 11. OpenCode integration

Bebop is fully committed to OpenCode. There is no harness abstraction layer: Swordfish binds directly to the OpenCode SDK and event types, and the bebop plugin is a first-class module of the product. This commitment is deliberate — OpenCode's server API and web UI are the intended path to a richer cockpit later (out of scope — see the map). If the harness ever changes, rewriting Swordfish's integration layer is the accepted cost.

### 11.1 Server API

OpenCode's server is the automation seam. Swordfish uses:

- session creation and lookup;
- asynchronous prompts;
- session abort;
- command execution;
- session status;
- message retrieval;
- the server-sent event stream;
- health and version information.

PTY keystroke injection must not be the primary automation mechanism.

### 11.2 The bebop plugin

The bebop OpenCode plugin and tool package provides:

- the `/auto` workflow;
- `set_spec`;
- `candidate_ready`;
- `blocked`;
- `continue`;
- role-aware handback;
- Swordfish status access;
- relevant workflow context in system prompts;
- correlation between OpenCode session IDs and seats;
- **the control-lease guard**: authoritative rejection of prompt submission to any seat whose lease is held by Swordfish (§11.5).

The plugin also listens for relevant OpenCode events, including:

- `session.idle`;
- `session.error`;
- `session.status`;
- message updates;
- permission events;
- command execution.

### 11.3 Idle recovery

The preferred completion protocol is explicit:

```text
candidate_ready | blocked | continue
```

If an autonomous seat becomes idle without reporting a disposition, Swordfish waits a quiet period and then re-prompts once:

> You returned control without reporting workflow state. Inspect the current work and report candidate_ready, blocked, or continue.

Repeated failure becomes `needs_attention`.

### 11.4 Permissions _(resolved)_

The VM is the sandbox; the harness does not enforce permissions a second time.

- **Ein:** all OpenCode permissions allowed. No interactive permission prompts can occur.
- **Jet / faye:** locked profiles set at seat creation (§14.2) so prompts cannot occur.
- If a permission event nonetheless fires while Swordfish holds the lease, Swordfish denies it, logs it, and continues; repeated denials escalate to `needs_attention`.
- No human-in-the-loop permission flow exists in autonomous mode.

### 11.5 Control lease

Only one actor may submit prompts to a controlled seat: `human` or `swordfish`.

Enforcement is layered _(revised 2026-07-26 after the lease-guard spike; see §16.2)_:

1. **tmux (UX layer):** the cockpit disables keyboard input to Swordfish-controlled seat panes.
2. **plugin (authoritative layer for model turns):** the bebop plugin rejects prompt submission on a leased seat regardless of how the prompt arrived — including a user who opens a second OpenCode client from a shell pane.
3. **transport layer (required):** Swordfish spawns the seat's OpenCode server with a random per-boot `OPENCODE_SERVER_PASSWORD` and a private `OPENCODE_DB`, so the server is unreachable without the secret and its sessions are invisible to any other OpenCode instance.
4. **detection layer (required):** Swordfish knows which prompts it originated. Any message or tool execution on a leased seat that Swordfish did not originate is recorded as an intrusion and escalates to `needs_attention`.

The spike in `prototypes/lease-guard/` proved against pinned OpenCode 1.18.5 that:

- throwing from `chat.message` or `command.execute.before` aborts the turn **before the model provider is contacted**, covering `POST /session/:id/message`, `POST /session/:id/prompt_async`, and `POST /session/:id/command`;
- `POST /session/:id/shell` executes in a leased seat **without invoking any plugin hook**, so the plugin alone cannot satisfy "regardless of how the prompt arrived";
- session state is shared per project on disk, and `opencode serve --pure` skips project-local plugins, so a second instance in the same directory drove a leased seat with no guard loaded;
- `OPENCODE_SERVER_PASSWORD` (HTTP Basic, username `opencode`) returns `401` on every route including `/shell`, and a private `OPENCODE_DB` makes the seat unreachable from another instance even by explicit session ID;
- a hook's thrown message does not reach the HTTP caller — the synchronous route returns an opaque server error and the asynchronous route returns `204` — so the "run the takeover command" instruction must be delivered through the event stream, the seat TUI, or the Swordfish status pane, not the response body.

The layers compose and fail independently, which is the point: the plugin is authoritative for model turns, the transport controls close the routes and instances the plugin cannot see, and detection is route-agnostic so it still catches an unhooked route added by a future OpenCode version. Bypass remains possible for a determined operator with a shell in the VM — that is accepted (§21.1), and the goal is that it cannot happen by accident. Any test of the guard must assert that the model endpoint received zero requests, not merely that an error was returned.

#### Seat credential lifecycle

The seat server's password is not ambient configuration. It is the write capability for the seat, and its lifetime is bound to the control lease.

- **Swordfish never publishes it.** `sf status` shows the seat URL, the session ID, and the lease owner, but not the credential. The tmux seat pane is already attached, so the normal observe-and-takeover path never needs it.
- **`sf takeover` may issue it.** A user who wants a second client — a wider terminal, a separate SSH session — receives the credential as part of takeover, which is already a durable, recorded state transition. Obtaining the ability to write to a seat therefore cannot happen without recording that it was taken.
- **Any release of control revokes it.** Whenever the lease returns from `human` to `swordfish` — explicit `sf handback`, the `/auto` confirmation flow, or role-aware plugin handback — Swordfish rotates the seat password if one was issued during that control episode. Rotation invalidates any client the user left attached elsewhere.
- **Rotation is conditional.** If no credential was issued during a control episode, there is nothing to revoke and no rotation occurs. This keeps the common path — the user steering through the tmux pane and handing back — free of a seat-server restart.

The resulting invariant: **no human-held seat credential survives a control release.** A user who wants back in runs `sf takeover` again. This is what makes the lease meaningful after the first takeover; without rotation, one takeover would grant permanent shell-route access to that seat and every later lease would be advisory.

Rotating the password requires restarting the seat's OpenCode server, because `OPENCODE_SERVER_PASSWORD` is read at process start. Sessions survive the restart because they live in the seat's `OPENCODE_DB`, but Swordfish must re-attach the seat panes and re-establish its own event subscription. Handback and `set_spec` are already safe-point transitions, so this is an acceptable place to absorb a restart — but it is a real moving part and must be reconciled like any other externally visible operation (§22.3).

Takeover and handback are durable state transitions, not cosmetic terminal modes.

## 12. Swordfish workflow

### 12.1 Inner state machine

```text
INTERACTIVE
  │ confirmed set_spec
  ▼
IMPLEMENTING
  │ candidate_ready(SHA)
  ▼
LOCAL_VALIDATION
  │ pass
  ▼
PUSHED_CANDIDATE
  ├──────────────┬─────────────────┐
  ▼              ▼                 │
PR_CI         CODE_REVIEW           │
  └───────┬──────┘                 │
          │ both pass              │
          ▼                        │
     QA_PREPARING                  │
          ▼                        │
        QA_RUNNING                 │
          │ pass                   │
          ▼                        │
     EVIDENCE_UPLOAD               │
          ▼                        │
         READY                     │
                                   │
Any blocking result ──→ REVISION ──┘
```

Exceptional states:

- `HUMAN_CONTROLLED`;
- `NEEDS_ATTENTION`;
- `BLOCKED`;
- `CANCELLING`;
- `CANCELLED`;
- `FAILED`.

### 12.2 Candidate submission

Ein must explicitly submit a candidate. Swordfish validates that:

- the commit exists;
- it is reachable from the assigned branch or can be pushed there;
- ein's worktree has no relevant uncommitted changes omitted from the submission;
- the submitted spec revision is current;
- repository configuration is readable;
- no other candidate verification remains authoritative.

### 12.3 Clean-room verification worktree

For every candidate, Swordfish creates a separate ephemeral worktree pinned to the exact candidate SHA.

This worktree:

- does not share uncommitted files with ein's worktree;
- uses isolated ports;
- uses disposable databases and service state;
- executes Swordfish-controlled hooks;
- is destroyed after its evidence is captured.

### 12.4 Local validation

Ein may run any checks it finds useful while developing. Those runs do not count as authoritative readiness evidence.

Swordfish independently executes mandatory repository validators against the clean-room worktree and records:

- command;
- environment profile;
- start and end time;
- exit status;
- captured output;
- relevant artifact paths;
- candidate SHA.

Any failure returns structured feedback to ein's seat.

### 12.5 PR and CI

Bebop creates a draft pull request after the first pushed diff.

After local validation passes:

- the candidate is pushed;
- the draft PR head is updated;
- bebop observes external PR checks for that SHA by polling the GitHub checks API (§19.3);
- CI and independent code review run in parallel.

Repository CI should run on draft PR creation and synchronization. It should not wait for the PR to become ready for review.

### 12.6 Code review (jet)

Jet is a distinct seat without ein's conversational context. Independence comes from context isolation and read-only tooling, not vendor diversity (§14.1).

Jet receives:

- the effective spec;
- base and candidate SHAs;
- the complete diff;
- relevant repository instructions;
- local validator output;
- any available CI status;
- read-only repository tools;
- web research tools.

Jet does not receive ein's production-context MCPs by default and cannot edit the repository.

Findings are structured:

```ts
interface ReviewFinding {
  id: string;
  severity: "blocking" | "non_blocking";
  title: string;
  description: string;
  evidence: string;
  file?: string;
  line?: number;
  suggestedDirection?: string;
}
```

Only `blocking` findings block readiness. Non-blocking findings ride the evidence bundle and are summarized in a PR comment at ready time _(provisional)_.

### 12.7 QA (faye)

QA begins only after both external CI and code review pass for the exact candidate SHA.

Faye receives:

- the effective spec;
- the candidate SHA;
- repository read access;
- Playwright-based browser tools _(provisional)_;
- clean private preview URLs;
- repository-defined QA scenarios;
- optional Figma access.

Faye does not edit code.

Swordfish prepares QA with `.bebop/` hooks in a clean worktree and disposable runtime state. QA evidence may include screenshots, recordings, console logs, network logs, and structured scenario outcomes.

**Clean-candidate proof** _(provisional)_: faye only ever receives preview URLs that Swordfish itself provisioned from the SHA-pinned QA worktree; Swordfish records the SHA, ports, and service PIDs in the QA evidence manifest. Cryptographic attestation of what the preview served is deferred.

### 12.8 Revision

CI, review, and QA failures are normalized and returned to ein's original seat.

Structured stage results — validator runs (§12.4), review findings (§12.6), and QA scenario outcomes (§12.7) — **ride the Bebop-Swordfish protocol** on the `gate_completed` event, bound to the same candidate SHA and spec revision as the gate outcome. They do not ride the evidence bundle, which remains the durable archive rather than the feedback channel.

A gate that failed **must** carry its structured result. A stage whose agent produced nothing usable — prose instead of findings, output that does not decode, an abort before any output — records that explicitly, with a reason. This is a detectable error rather than a silent absence, and it is deliberately not the same value as a clean result: "jet found nothing" and "jet did not answer" must never be indistinguishable.

Ein:

1. receives an aggregated feedback packet;
2. preserves its original conversational and implementation context;
3. revises the work;
4. submits a new candidate commit.

Every new commit invalidates:

- local validation;
- external CI;
- review approval;
- QA approval;
- readiness;
- commit-bound evidence claims.

The full pipeline restarts.

### 12.9 Seat reuse for jet and faye

Reusing jet's or faye's seat for a later revision may reduce token usage, but it is an optimization rather than an MVP requirement.

The first review remains context-independent from ein. Every result remains commit-bound even when a seat is reused.

## 13. Repository-owned configuration: `.bebop/`

### 13.1 Layout _(resolved)_

```text
.bebop/
  config.yml        # services, ports, preview labels,
                    # timeouts, env requirements,
                    # privilegedPaths (extra globs)
  setup/
    primary         # full dev env for ein's worktree
    verification    # deps-only clean-room setup
    qa              # QA env: services + seed data
  hooks/
    validate        # authoritative validators
    qa-start        # boot QA services, wait healthy
    qa-reset        # reset disposable state
    collect-evidence# emit extra artifact paths
```

### 13.2 Hook contract _(resolved)_

Every `setup/` and `hooks/` entry is a plain executable in any language.

```text
exit 0 = pass, nonzero = fail
stdin:  nothing
env:    BEBOP_SHA, BEBOP_STAGE, BEBOP_WORKTREE,
        BEBOP_PORT_*, BEBOP_RESULT_FILE, BEBOP_ARTIFACT_DIR
optional: write JSON findings to $BEBOP_RESULT_FILE
artifacts: copy into $BEBOP_ARTIFACT_DIR
```

Exit code is authoritative; stdout/stderr are captured as logs. Structured results and artifacts are optional enrichments.

`config.yml` declares:

- dependency and environment requirements;
- services, ports, health checks, and preview labels (also used for cockpit log panes);
- seed data;
- timeouts;
- additional privileged path globs (§13.3).

### 13.3 Trust rule _(resolved)_

The candidate cannot be allowed to weaken the rules that evaluate it.

- **`.bebop/**` is always privileged.** This is hardcoded and cannot be disabled — the agent can never unprotect the configuration by editing it.
- Repositories may declare **additional privileged globs** in `config.yml` (e.g. `.github/workflows/**`, which the default template includes). The glob list is read from the base revision, so it protects itself.
- Mandatory hooks and configuration are loaded from the base revision;
- candidate-added checks may also run;
- any candidate change under a privileged path forces `needs_attention`;
- the cockpit and CLI display the exact configuration diff;
- no autonomous path may approve that change.

**Approval flow** _(resolved)_: the user runs

```text
bebop bounty approve-config <bounty> --sha <candidate-sha>
```

The approval is recorded against that exact SHA. The pipeline resumes, and gates run using the approved candidate's configuration. Any later commit touching privileged paths requires a fresh approval. Unchanged privileged paths continue loading from base.

This rule intentionally affects legitimate repository-tooling tasks. Those tasks require human inspection of the privileged diff.

### 13.4 Hook execution

Hooks execute inside the sandbox and must not receive bebop credentials. They may produce structured results and local artifacts but do not publish externally themselves.

## 14. Context, models, and capability profiles

### 14.1 Seat models _(resolved)_

| Seat | Model                | Effort  | Credential path                                        |
| ---- | -------------------- | ------- | ------------------------------------------------------ |
| ein  | GPT-5.6 Sol          | high    | ChatGPT subscription via exe.dev LLM integration       |
| jet  | GPT-5.6 Sol          | medium  | Same integration, same provider                        |
| faye | GLM 5.2 (or similar) | default | OpenCode Go via exe.dev HTTP Proxy integration (§20.2) |

Notes:

- Jet's independence is **context isolation plus read-only tooling**, not vendor diversity. (The operator's Anthropic subscription is unusable outside Claude Code, so a decorrelated frontier reviewer is not currently available; revisit if credentials change.)
- Vendor diversity lands at faye instead — the least judgment-critical seat.
- Per-seat model and effort are configuration fields, not hardcoded.
- The exe.dev LLM integration carries ein and jet. Faye uses a generic credential-injecting HTTP proxy because the LLM integration does not support arbitrary provider endpoints (§20.2).

### 14.2 Role capability profiles

**Ein**

- provision-time context selection from the catalog: Sentry, Figma, PostHog, Railway, Context7 MCPs (Cloudflare and Axiom expected later);
- full edit and execution permissions inside the sandbox (§11.4).

**Jet**

- repository read access;
- diff access;
- validator and CI output;
- web search and fetch;
- no code edits;
- no production-context MCPs by default.

**Faye**

- repository read access;
- browser automation;
- private preview access;
- optional Figma access;
- no code edits;
- no broad production or infrastructure tools.

**Swordfish**

- OpenCode control API;
- local process, filesystem, Git, and hook execution;
- bebop callback channel;
- no user-level context MCPs.

### 14.3 Capability authority

The sandbox may report that it needs another capability, but it cannot attach or grant one. Capability changes require a bebop action and become bounty metadata.

Read and write capabilities should be distinct where an integration supports that separation.

## 15. Constraints and escalation

Each bounty has a configurable constraint profile. Shipping defaults _(provisional)_:

```yaml
constraints:
  primary:
    maxTurnsPerAttempt: 40
    maxWallClockMinutesPerAttempt: 90
  review:
    maxRounds: 3
    maxTurnsPerAttempt: 15
    maxWallClockMinutesPerAttempt: 30
  qa:
    maxRounds: 3
    maxTurnsPerAttempt: 20
    maxWallClockMinutesPerAttempt: 45
```

Swordfish maintains a constraint ledger rather than resetting counters globally.

When a constraint is exhausted:

1. the active agent is stopped or allowed to reach a safe point;
2. Swordfish records the exact exhausted constraint;
3. the bounty enters `needs_attention`;
4. the user may take over and inspect or steer;
5. handing control back grants one additional life only to the exhausted constraint.

No retry resets unrelated counters.

**Flakiness** _(provisional)_: there are no automatic retries of validators, CI checks, or QA scenarios. A human may re-run a failed stage once via `sf retry <stage>`. Chronic flakiness is the repository's bug to fix, not bebop's to mask.

## 16. Cockpit and control

### 16.1 Layout _(resolved)_

The cockpit is a Swordfish-owned tmux session reached over SSH (mosh after SSH works). It contains:

- a **status pane** — a small TUI Swordfish renders: bounty and repo identity, bebop connection freshness, workflow stage, active seat, lease owner, branch and candidate SHA, gate statuses, constraint consumption, preview URLs, recent events;
- **seat panes** — the real OpenCode TUIs for ein, jet, and faye (when they exist), visible at all times;
- **free shell panes** — ordinary shells for exploring the VM: dev servers, log files, processes, Git state. Nothing about supervision restricts these;
- **service log panes** — generated from the `services` list in `.bebop/config.yml` _(provisional)_.

### 16.2 Steering safety

The cockpit's job is not only access but **protection from accidental interference**: the user must not be able to naively steer an agent mid-flight and corrupt bounty state.

- tmux disables keyboard input to seat panes whose lease Swordfish holds (UX layer);
- the bebop plugin authoritatively rejects any prompt or command reaching a leased seat by other routes (§11.5);
- the seat's OpenCode server requires a Swordfish-held password and keeps private session storage, closing the shell route and second-instance access that plugin hooks cannot see (§11.5);
- Swordfish records any seat activity it did not originate as an intrusion (§11.5);
- all steering flows through explicit `sf` commands.

### 16.3 Commands _(provisional)_

The in-cockpit `sf` CLI provides:

```text
sf status
sf takeover <seat> [--force]
sf handback
sf extend <constraint>
sf retry <stage>
sf approve-config
sf stop
```

Safe takeover waits for a session-abort point (abort → idle event → last message ID recorded); `--force` interrupts immediately. Config approval is also available remotely via `bebop bounty approve-config`.

`sf status` prints the seat server URL, each seat's session ID, and the lease owner, but never the seat credential. `sf takeover` optionally issues that credential so the user can attach a second client:

```text
opencode attach <seat-url> --session <session-id> --password <credential>
```

The credential is a seat-server HTTP Basic password (username `opencode`). `OPENCODE_DB` is server-side only, so a client never needs the database path. `sf handback` and the `/auto` flow revoke it (§11.5).

Swordfish must not export the credential into the tmux session environment or a shell profile: `opencode attach` defaults `--password` to `OPENCODE_SERVER_PASSWORD`, so an inherited variable would silently re-grant seat write access to every free shell pane. It is passed only to the processes Swordfish itself spawns.

### 16.4 Handback

Handback must be explicit. Swordfish never guesses that closing SSH means autonomous work should resume.

Every handback revokes the seat credential if one was issued, so a client the user left attached in another terminal stops working at the moment control returns. This is why disconnecting SSH cannot imply handback and also cannot leave a usable write path open: the lease and the credential expire together, and only together.

For ein's seat, the role-aware `/auto` flow asks the agent to determine whether:

- the current effective spec still applies; or
- the conversation changed the effective spec.

The user confirms any proposed new spec revision before Swordfish resumes.

Taking over jet or faye is recorded as evidence provenance. Human-steered results remain valid.

### 16.5 Herdr compatibility

[Herdr](https://github.com/ogulcancelik/herdr) already provides valuable multi-agent UX, persistent remote sessions, OpenCode detection, read-only terminal observation, and a broad local socket API. It is not the MVP cockpit authority because its current full-workspace client does not provide a supervisor-enforced per-pane input lock across every TUI, CLI, and socket input path. Its direct-terminal controller has single-writer takeover semantics, but that does not lock the corresponding pane against other Herdr control paths.

Layering Herdr over a Swordfish-owned tmux session is also rejected: Herdr cannot adopt tmux panes, and nested multiplexers add terminal and recovery failure modes without strengthening the control lease. Replacing tmux becomes viable when Herdr provides:

- a per-pane input lock enforced across full-workspace clients, direct attach, CLI, and socket methods;
- explicit controller lease, takeover, and handback semantics;
- caller-owned stable resource references or idempotent ensure operations;
- authenticated or capability-scoped socket clients;
- reliable snapshot-plus-subscribe reconciliation after reconnect.

Herdr is therefore not included in the MVP cockpit. Any experiment must remain non-authoritative and prove that it cannot submit prompts, mutate cockpit topology, or bypass the control lease.

### 16.6 Cockpit v2

A deep OpenCode-plugin cockpit — exposing shell access, seat multiplexing, and lease controls through the OpenCode web UI — is the intended future direction but is explicitly out of MVP scope (out of scope — see the map).

## 17. Bebop API and CLI

### 17.1 API-first discipline _(resolved)_

- All request, response, and event shapes are defined as **Effect Schema** types in a shared package.
- The OpenAPI document is **generated from those schemas** via Effect HttpApi (currently `effect/unstable/httpapi` in the pinned Effect 4 beta); it is the contract future clients (GUI, Linear) build against.
- The CLI is a thin wrapper over the generated client with **zero CLI-only logic**; anything the CLI can do, any API client can do.
- Every CLI command supports `--json`.

### 17.2 Routes

```text
POST   /api/bounties
GET    /api/bounties
GET    /api/bounties/:bountyId
GET    /api/bounties/:bountyId/events        # SSE live + cursor replay
GET    /api/bounties/:bountyId/attachments
GET    /api/bounties/:bountyId/evidence
POST   /api/bounties/:bountyId/approve-config
POST   /api/bounties/:bountyId/merge
POST   /api/bounties/:bountyId/stop
POST   /api/bounties/:bountyId/recover
DELETE /api/bounties/:bountyId
POST   /api/tokens
GET    /api/tokens
DELETE /api/tokens/:tokenId
GET    /api/health                           # unauthenticated liveness
```

The token routes back `bebop token create|revoke|list` in §17.3. They were previously absent from this table while the CLI listed the commands, which contradicted `ABSTRACT.md` §3.3's rule that the CLI has no behavior the API lacks. The create response is the only place a token's plaintext exists; §17.4 stores it hashed, and listing returns metadata only.

`GET /api/health` is the **one unauthenticated route**. §24 runs health-checked blue/green containers behind Caddy, and requiring a bearer token for a liveness probe would mean baking a durable credential into the image or the compose file purely to ask a process whether it is alive. The route exposes liveness and nothing else; every route that can read or change bounty state is authenticated.

The events endpoint serves the stored event projection: live via SSE, historical via cursor-based replay. This exists in the MVP precisely so reactive clients never need to be retrofitted. Webhooks (outbound push) remain deferred.

### 17.3 CLI surface

```text
bebop bounty create
bebop bounty list
bebop bounty status
bebop bounty attach
bebop bounty events        # tail the SSE stream
bebop bounty evidence [--download <dir>]
bebop bounty approve-config
bebop bounty merge
bebop bounty stop
bebop bounty destroy
bebop token create|revoke|list
```

### 17.4 Authentication _(resolved)_

Two layers:

1. the API is reachable only through the exe.dev **private URL** (exe.dev auth is layer one);
2. bebop-issued **named bearer tokens** (e.g. `fern-cli`, later `linear-bot`), stored hashed in Postgres, checked on every request, individually revocable.

A fresh database is bootstrapped with one named token from `BEBOP_BOOTSTRAP_API_TOKEN`. The API consumes this
value only while `api_tokens` is empty; once any token row exists, startup never recreates or un-revokes a token
from environment configuration. Operators create durable client tokens through the authenticated token API and
may then remove the bootstrap value from the deployment environment.

The CLI stores its token in local config. Public exposure is a deferred decision made when an integration actually needs inbound traffic (e.g. GitHub webhooks, Linear).

### 17.5 Status vocabulary

Compact status for `bounty list`:

- `provisioning`;
- `interactive`;
- `autonomous`;
- `human_controlled`;
- `needs_attention`;
- `ready`;
- `merging`;
- `done`;
- `failed`;
- `stopped`.

Detailed Swordfish stage and freshness are separate fields.

### 17.6 Notifications

The MVP has no outbound notification system. The user runs `bounty list`, `bounty status`, or tails `bounty events`. The SSE feed is the substrate a future notifier, dashboard, or Linear integration consumes.

## 18. Bebop-to-Swordfish protocol

### 18.1 Connection direction

Each Swordfish initiates an outbound, reconnecting WebSocket to bebop.

The channel carries:

- Swordfish registration;
- heartbeats;
- sequenced state events;
- attachment updates;
- evidence-upload negotiation;
- bebop commands;
- acknowledgement cursors;
- stop and lifecycle messages.

### 18.2 Authentication _(resolved)_

- a bounty-scoped token minted by bebop and injected at VM bootstrap;
- bound to the expected VM identity (bounty ID ↔ VM ID);
- presented on the WebSocket upgrade, and valid for the life of the bounty.

The plaintext token is derived at provisioning time as HMAC-SHA-256 over the bounty ID using the redacted
deployment key `BEBOP_SWORDFISH_CREDENTIAL_KEY`. Postgres stores only the resulting token hash. Derivation makes
an interrupted idempotent provisioning retry hand the provider the same credential without storing recoverable
plaintext. The deployment key must remain stable while any bounty is live; rotation requires draining or
explicitly reprovisioning those bounties.

Rotation and expiry were specified here and never built, which left Milestone 5's "an invalid token is rejected" scenario with no contract to test the token half against. Both are struck rather than implemented.

Expiry on a wall clock is a lockout: the token is checked only at the upgrade, so a Swordfish that stays connected longer than the token's lifetime reconnects with a dead credential and there is no mid-connection route to re-issue one. Rotation would need that route, or a handback slot in the registration exchange, to be worth having — and neither buys much against the threat model in §21.1, since the credential lives on the VM full-time either way. A token that leaks off the VM is bounded by the bounty's own lifetime, and bebop revokes it at deprovisioning.

### 18.3 Delivery

Swordfish events use at-least-once delivery and stable sequence numbers.

Swordfish stores unsent events in SQLite. After reconnecting, it replays from bebop's acknowledged cursor.

Bebop deduplicates events and commands.

### 18.4 Offline behavior

Temporary master unavailability does not stop in-sandbox implementation, validation, review, or QA. Operations that require bebop authority — PR creation, CI observation, evidence publication, merge, VM destruction — wait for reconnection.

## 19. Source control and pull requests

### 19.1 Git integration

The MVP uses exe.dev's per-repository GitHub integration.

Advantages:

- agents use normal Git commands;
- the reusable GitHub credential remains off the VM;
- access is scoped to a configured repository;
- pushes are attributed to the exe.dev GitHub App rather than the user's identity.

The integration should not use `--act-as-user`.

### 19.2 Accepted residual risk

exe.dev currently documents repository-level writable or read-only integration, not per-bounty branch-only writes.

The MVP accepts that a compromised writable sandbox may modify unprotected refs in its allowed repository.

Mitigations:

- default, release, and other sensitive branches use GitHub rulesets;
- the exe.dev GitHub App cannot bypass those rules;
- merge targets require pull requests and required checks;
- bebop uses a separate GitHub App identity;
- bebop verifies the exact head SHA before merge;
- only bebop performs merges;
- bounty branches use the recognizable `bounty/*` namespace;
- unexpected branch-head movement invalidates readiness.

A custom branch-scoped Git gateway is deferred.

### 19.3 CI observation _(resolved)_

The MVP intentionally keeps bebop's selected ingress private, so GitHub webhooks cannot reach it. exe.dev can expose a selected port publicly, but doing so would broaden the ingress and require bebop to authenticate every non-webhook route itself. Bebop therefore observes PR checks by **polling** the GitHub checks API. A dedicated signature-verifying public relay or a traditionally hosted public ingress is deferred.

### 19.4 Merge policy _(resolved)_

- **Squash-only.** One bounty = one PR = one commit on the base branch. Agent WIP noise never reaches history; revert is one commit.
- The squash commit message includes the bounty ID and evidence link.

### 19.5 Commit authorship _(resolved)_

- Commits are authored as the acting seat, e.g. `ein (bebop) <bounties+<id>@bebop.local>`;
- pushes are attributed to the exe.dev GitHub App;
- the user's personal GitHub identity never appears as author or committer.

### 19.6 Base drift _(resolved)_

Base-branch advance does **not** invalidate readiness by itself:

- bebop tracks mergeability via GitHub;
- status always shows "behind base by N";
- if the PR becomes unmergeable, the bounty drops to `REVISION` and ein is instructed to **merge the base branch back into the bounty branch** (not rebase — one conflict-resolution pass instead of many; the merge commit disappears in the squash);
- the resulting new SHA reruns the full pipeline as usual;
- semantic conflicts between parallel green bounties are accepted risk; post-merge CI on the base branch is the backstop.

### 19.7 PR lifecycle

1. Bebop creates the assigned branch.
2. Ein works normally and may push.
3. After the first pushed diff, bebop creates a draft PR.
4. Candidate pushes update the draft PR and trigger external CI.
5. Swordfish verifies candidates while the PR remains draft.
6. When all gates pass for the current SHA, bebop marks the PR ready.
7. The user explicitly commands bebop to merge.
8. Bebop revalidates the head and squash-merges.

### 19.8 GitHub App permissions _(provisional)_

Bebop's App: contents RW, pull_requests RW, checks read, statuses read, metadata read — a separate identity from the exe.dev push App.

## 20. exe.dev integration

### 20.1 Compute _(resolved)_

exe.dev is the only bounty compute provider. Bounty VMs are created **fresh from a versioned bebop base image** containing: pinned OpenCode + bebop plugin, Swordfish, tmux, Playwright browsers, and common runtimes.

- Repo clone and `.bebop/setup/primary` run at provision time; duration is visible in status.
- Image upgrades (including OpenCode version bumps) are qualified by running a smoke bounty on a test repository before rollout _(provisional)_.
- Warm per-repo snapshots are a deferred optimization (out of scope — see the map).

Compute profiles _(provisional)_: `small` (2c/4GB), `standard` (4c/8GB, default), `large` (8c/16GB).

### 20.2 LLM authentication

The exe.dev LLM integration supports Anthropic, OpenAI, and Fireworks with a per-provider strategy. Bebop configures:

- **OpenAI provider** (ChatGPT subscription) → ein and jet.

OpenCode is configured to use the internal integration endpoint. No reusable OpenAI credential is stored in the bounty VM.

Faye uses a separate exe.dev **HTTP Proxy integration** targeting `https://opencode.ai/`. The integration injects the OpenCode Go bearer credential server-side, and OpenCode uses the proxy base URL ending in `/zen/go/v1`. The specialized exe.dev LLM integration is not an arbitrary-provider proxy and is not used for this path.

This design must pass a provisioning smoke test before the credential-off-VM rule is considered implemented:

- list models through `/zen/go/v1/models`;
- stream a GLM 5.2 chat completion;
- verify how the proxy handles a caller-supplied `Authorization` header;
- cancel a streaming request and verify timeout behavior;
- verify target-path joining and normalization.

If OpenCode requires a local API-key field, it receives a harmless placeholder only after the header-collision test proves that exe.dev replaces it with the injected credential. Failure of any test blocks faye provisioning; it does not permit the reusable credential to fall back into the VM.

### 20.3 Context authentication

Where supported, external MCP and HTTP services use exe.dev credential-injecting integrations. Keeping a token off the VM does not reduce the authority of requests the sandbox can send, so seat capability selection still matters. Integrations are VM-scoped rather than seat-scoped: every process in an attached VM can invoke the OpenCode Go proxy, even though only faye is configured to use it. Attach only explicitly selected integrations; do not rely on `auto:all` defaults.

### 20.4 Preview URLs

All previews remain private.

Bebop records private URLs and the ports or labels they represent. The user authenticates through exe.dev. Faye may use localhost or the private URL as appropriate.

Public preview sharing is out of scope.

### 20.5 VM loss

Permanent VM loss is an extreme, explicit recovery event.

Bebop may create a replacement VM from the assigned branch and master-side effective spec. The replacement begins with:

- a fresh Swordfish database;
- fresh seats;
- a clean checkout;
- preserved bounty identity and artifacts.

Transparent continuation of the lost model context is not promised.

### 20.6 Retention and orphans _(provisional)_

- merged → VM deprovisioned after a 1-hour grace period;
- stopped / failed / needs_attention → VM kept 7 days, then destroyed (evidence has already been uploaded);
- bounty records are kept in Postgres indefinitely;
- a periodic reconcile job diffs bebop-tagged exe.dev VMs against Postgres; unknown VMs are flagged and destroyed after a grace window.

## 21. Security model

### 21.1 Trust assumptions

The MVP is single-user or trusted-small-team software operating on repositories owned by the operator.

Repository content, task prompts, external web pages, logs, Sentry events, analytics data, and MCP results remain untrusted model input.

### 21.2 Sandbox authority

The sandbox may receive:

- read and limited write access to one repository through exe.dev;
- model access through the exe.dev LLM and HTTP Proxy integrations;
- selected context integrations;
- a bounty-scoped Swordfish connection;
- local development services.

Faye's OpenCode Go credential is held by the exe.dev HTTP Proxy integration described in §20.2. The VM receives only the proxy hostname and, if OpenCode requires one, a non-secret placeholder. This keeps the reusable credential unreadable from the sandbox while acknowledging that the sandbox can still spend its quota through the proxy.

The sandbox must not receive:

- exe.dev account credentials;
- bebop GitHub App credentials;
- protected-branch bypass authority;
- PR merge authority;
- master Postgres credentials;
- evidence-sink credentials;
- unrestricted infrastructure credentials;
- authority to provision sibling VMs;
- authority to attach new integrations.

### 21.3 Seat permissions

OpenCode permissions are role-specific and static (§11.4, §14.2): ein may edit and execute; jet is read-only; faye is read-only plus browser and local QA services; Swordfish controls processes but receives no user context tools.

### 21.4 Configuration tampering

Any candidate change to a privileged path (`.bebop/**` always; repo-configured globs additionally) blocks autonomous readiness and requires explicit, SHA-pinned human approval (§13.3).

### 21.5 Merge integrity

A merge command is valid only for the bebop-observed PR head and its matching readiness record. A changed head requires the full pipeline again.

## 22. Persistence and recovery

### 22.1 Master state

Postgres on the master VM stores:

- bounties;
- VM mappings;
- branch and PR mappings;
- lifecycle commands;
- Swordfish event projections;
- connection freshness;
- API tokens (hashed);
- privileged-path approvals;
- evidence metadata;
- constraint-escalation summaries;
- merge records;
- idempotency keys.

### 22.2 Swordfish state

SQLite inside each bounty VM stores:

- inner workflow events;
- seat identities;
- effective-spec revisions;
- current control lease;
- constraint ledger;
- candidate SHAs;
- validator outcomes;
- review and QA findings;
- local artifact manifests;
- unsent bebop events.

### 22.3 Swordfish restart

On restart, Swordfish:

1. loads SQLite;
2. inspects Git worktrees and processes;
3. queries the OpenCode server;
4. reconciles seat status;
5. reconnects to bebop;
6. replays unsent events;
7. resumes only after it can prove the current stage.

It must not send a duplicate prompt merely because it cannot immediately determine whether a previous prompt completed.

### 22.4 Master restart

On restart, bebop:

- reconnects to Postgres;
- resumes idempotent provisioning and cleanup operations;
- accepts Swordfish reconnects;
- rebuilds in-memory projections;
- reconciles exe.dev VMs and GitHub PR heads;
- does not recreate already-existing VMs or branches.

### 22.5 Compaction

OpenCode session compaction requires no extra checkpoints: durable workflow truth (spec revisions, candidates, feedback packets) lives in Swordfish's SQLite, and Swordfish restates the effective spec and current stage in every autonomous prompt, so compaction cannot lose workflow state _(provisional)_.

## 23. Evidence

### 23.1 Upload seam

Swordfish uploads evidence blobs and structured metadata to bebop before claiming readiness.

Bebop associates evidence with the bounty and exact candidate SHA.

### 23.2 Storage _(resolved)_

- The MVP stores blobs in a raw filesystem content-addressed store on the persistent master artifact volume; metadata and bundle-to-blob references live in Postgres. A single-node MinIO service on the same VM is explicitly not used: it adds another daemon and credential surface without adding a failure domain, and the [original open-source MinIO repository](https://github.com/minio/minio) was archived in April 2026.
- Storage sits behind a small backend-neutral blob contract: put a verified immutable blob, stat, open or range-read, delete, and enumerate for repair or migration. Postgres stores content identity, never a filesystem path, endpoint, provider ETag, or bucket URL.
- Canonical object keys are `blobs/sha256/<first-two-hex>/<64-lowercase-hex>`. A future S3-compatible backend uses the same keys; SHA-256, not an object-store ETag, remains the content identity.
- Swordfish negotiates uploads per blob so content already present is skipped. Bebop streams each new blob to a temporary file while computing its hash and size, rejects mismatches, durably publishes it to the canonical key, and only then commits the manifest and references in Postgres.
- Each bundle carries a manifest: bounty, spec revision, candidate SHA, stage, tool and environment versions, and per-blob hashes. The size cap is 500 MB across referenced blob sizes before deduplication; large browser recordings never enter Postgres.
- Bundle references expire 90 days after a bounty is done or destroyed. A mark-and-sweep job deletes a blob only when no unexpired bundle references its hash; metadata is kept. Temporary and unreferenced blobs receive a grace period before collection.
- If local-volume durability or recovery time becomes unacceptable, use managed remote S3-compatible storage directly rather than inserting single-node object storage on the same VM. The backend must pass conformance tests for checksums, concurrent identical writes, range reads, multipart completion, and read-after-write behavior before migration.

### 23.3 Access _(provisional)_

`bebop bounty evidence <id> [--download <dir>]`; bundles are also browsable through bebop's private URL.

### 23.4 External publication

The MVP's first (and only) publication sink is a **GitHub PR comment** posted by bebop at ready time: a summary plus key screenshots and links _(provisional)_. Linear publication comes later. Off-VM S3-compatible backup is an operational concern rather than a publication sink. The sandbox never receives publication credentials.

## 24. Master deployment

Bebop runs on a dedicated, long-lived exe.dev master VM for the MVP. This is a convenience and scope decision, not a requirement created by the provisioning API: no documented network-local provisioning path makes an exe.dev-hosted master faster than an external host.

The exe.dev master is useful for a personal MVP because it provides private HTTPS ingress and identity, straightforward SSH operations, familiar image and deployment tooling, and one provider to provision and debug. A peer HTTP-proxy integration may also authenticate bounty-to-master traffic, subject to a WebSocket smoke test; the bounty-scoped token remains required.

The tradeoff is correlated failure and authority: the master, every bounty, the canonical database, and the local evidence volume share one provider, account, and region. The master also consumes the same resource pool, has no managed Postgres or object-storage durability, and cannot accept GitHub webhooks while its selected port remains private. A traditional host provides stronger failure-domain separation, managed stateful services, ordinary public ingress, and independent capacity.

The MVP accepts those costs to reduce initial infrastructure. Bebop remains deployment-neutral at its external seams: it talks to exe.dev over the public provisioning API, accepts outbound Swordfish connections, stores evidence through the blob contract, and depends on Postgres rather than exe.dev-local identity for application authorization. Off-VM backups are mandatory. Move the master to a traditional provider when webhook ingestion, managed Postgres/object storage, host availability, independent capacity, or reduced exe.dev blast radius becomes more valuable than built-in private ingress.

The deployment should be production-like despite using one host:

- containerized application modules (Docker Compose);
- Caddy reverse proxy;
- health-checked versioned bebop containers;
- **blue/green** _(provisional)_: two compose colors behind Caddy; deploy = start new color → health check → flip upstream → drain old;
- persistent Postgres volume;
- persistent artifact volume;
- backward-compatible database migrations;
- process supervision;
- structured JSON logs;
- **backups** _(resolved)_: nightly `pg_dump` plus the artifact volume in one encrypted restic snapshot to an off-VM S3-compatible bucket; alert on failure and test a sampled restore monthly;
- **observability floor** _(provisional)_: structured logs everywhere; minimal metrics — stage timings, token spend per seat, gate pass/fail rates.

The MVP does not provide host-level high availability. Loss or reboot of the master VM may cause downtime.

Conceptual services:

```text
caddy
bebop-api
bebop-worker
postgres
```

The API and worker may initially share one image while remaining separate logical responsibilities.

## 25. Implementation stack _(resolved)_

The **Effect ecosystem** on **Bun** _(runtime choice provisional)_, across all components:

| Concern              | Choice                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Language / runtime   | TypeScript on Bun (single-binary compile for Swordfish and the CLI)                                                                                          |
| Shared contracts     | Effect Schema in a shared monorepo package — API messages, Swordfish events/commands, effective specs, candidates, findings, constraints, evidence manifests |
| HTTP API             | Effect 4 `effect/unstable/httpapi` — OpenAPI generated directly from the schemas                                                                             |
| CLI                  | Effect 4 `effect/unstable/cli`, wrapping the generated API client                                                                                            |
| Platform services    | `@effect/platform-bun` — filesystem, path, stdio, HTTP server, and process spawning; required by the HTTP API, the CLI, and both Migrators                   |
| Postgres             | `@effect/sql-pg` + its Migrator                                                                                                                              |
| Swordfish SQLite     | `@effect/sql-sqlite-bun` + its Migrator                                                                                                                      |
| Background jobs      | Durable job rows in Postgres worked by Effect fibers in `bebop-worker`; `@effect/cluster` only if that outgrows a single worker _(provisional)_              |
| OpenCode integration | OpenCode SDK (from its OpenAPI spec) wrapped in Effect services; the bebop plugin shares the schemas package                                                 |
| QA browser           | Playwright, preinstalled in the base image, driven via Playwright MCP _(provisional)_                                                                        |
| Cockpit              | tmux + a small Swordfish-rendered status TUI                                                                                                                 |

Rust or Zig would reduce Swordfish's runtime memory, startup time, and binary size, but those improvements do not currently justify a second implementation language. OpenCode, language servers, repository builds, dev services, and Playwright dominate the 2c/4GB bounty profile. One TypeScript codebase also shares Effect schemas directly across bebop, Swordfish, the CLI, and the OpenCode plugin; a native supervisor would introduce generated cross-language contracts and a second concurrency and recovery model before the workflow is proven.

The MVP therefore keeps both services in TypeScript/Bun and runs Swordfish under an external process supervisor. It records Swordfish's PSS and peak memory, CPU and event-loop delay, file descriptors, buffered upload bytes, SQLite latency, crashes, restart recovery, and cgroup OOM events separately from child processes. Reconsider a Rust-only Swordfish after representative workloads show that it materially causes OOMs or stalls, sustains roughly 150–200 MB P95 working set after straightforward tuning, or that reclaiming its measured overhead would improve bounty throughput by about 10%. Zig is not a planned target; if a native rewrite is justified, Rust's async, SQLite, HTTP, process-management, and observability ecosystems fit this daemon better.
