# Bebop — Remote Supervised Coding Bounties

**Primary use case:** Personal background execution of many small-to-medium software-engineering tasks

**Bounty compute provider:** exe.dev

**Agent harness:** OpenCode (committed, no harness abstraction)

**Primary operator interface:** The `bebop` CLI plus SSH attachment to the cockpit

This is the north star: what Bebop is, why it exists, what it must and must not do, and what "done" looks like.
It is deliberately short. The rest of the documentation hangs off it:

- the vocabulary it uses is defined in [`CONTEXT.md`](./CONTEXT.md);
- what each capability delivers and where it stands is in [`docs/capabilities/`](./docs/capabilities/);
- the decisions behind it are in [`docs/adr/`](./docs/adr/);
- the route from here to the MVP is charted in [`.scratch/bebop-mvp/map.md`](./.scratch/bebop-mvp/map.md).

---

## 1. Summary

Bebop is a system for moving a trusted local coding-agent workflow onto remote computers without losing direct access, steerability, repository context, or independent verification.

The system's fundamental unit is a **bounty**:

```text
one bounty
= one isolated exe.dev VM
+ one crew of role-bound OpenCode seats
+ one assigned Git branch
+ at most one pull request
+ one in-sandbox supervisor (Swordfish)
```

The normal workflow is:

```text
interactive clarification
→ autonomous implementation
→ deterministic validation
→ external CI and independent code review
→ clean-environment QA
→ human inspection
→ bebop-authorized merge (the bounty is caught)
```

The user begins by creating and attaching to a bounty. They talk directly to the primary cowboy (**ein**) until the task is clear. A system-provided `/set-spec` workflow distills the conversation into a lightweight effective specification and asks the user to confirm it. The user then runs `/handoff` to give workflow control to **Swordfish**, the supervisor.

Swordfish then drives ein's seat autonomously, executes repository-defined validators against a clean worktree, activates the independent review cowboy (**jet**) in a fresh seat, activates the QA cowboy (**faye**) in another fresh seat against a clean development environment, and returns findings to ein for revision. Ein retains its conversational and implementation context throughout this loop.

The user can observe every seat, take control of the active cowboy, steer it, invoke role-valid workflow actions, and explicitly hand control to Swordfish. The system never merges code without an explicit user command.

Bebop is single-user or trusted-small-team software, operating on repositories the operator owns. It is not multi-tenant, and everything a model reads — repository content, task prompts, web pages, logs, analytics, MCP results — is treated as untrusted input. What keeps that safe is that high-value authority stays outside the sandbox; see [`docs/capabilities/`](./docs/capabilities/14-the-security-model.md).

The MVP deliberately does **not** solve large-project decomposition, implement a web dashboard, or make Linear the primary frontend. Those may be built later from the bounty primitive after real usage informs their design.

## 2. Motivation

The existing trusted development workflow is:

1. Give a local coding agent a reasonably specific task.
2. Let it implement the task in a repository with the right development context.
3. Inspect the local development server manually or ask an agent to verify it with a browser.
4. Push a branch and create a pull request.
5. Run a separate, fresh-context agent to review the pull request.
6. Return review findings to the original implementer so it can reuse its context.
7. Require runnable, screenshot, recording, or test evidence before merging.

This workflow works well for small and medium tasks. Its limitations are operational:

- local CPU, memory, disk, and port contention limit concurrency;
- each agent consumes a terminal and development environment;
- the user over-monitors active cowboys instead of moving to another task;
- background agents need access to the same logs, browsers, MCPs, and development services as local agents;
- review and QA loops require repetitive manual coordination;
- the user still needs a fast way to inspect and steer any loop that goes off track.

Large work currently requires a separate manual workflow in which the user develops loose plans or specifications and manually hands bounded phases to fresh agents. That workflow is acknowledged but is not part of this MVP.

The immediate product goal is therefore:

> Make one remote small-to-medium coding bounty as trustworthy and steerable as the current local workflow, then make it cheap to run many such bounties in parallel.

## 3. Product principles

### 3.1 Automate the workflow that already works

The product should automate implementation, review, revision, and QA coordination without inventing a requirements-management platform or an autonomous product-management layer.

### 3.2 Native cowboy seats remain visible

The primary human interaction is the real OpenCode session, not a reconstructed chat interface. The user must be able to see the harness output, attach to the workspace, inspect processes and logs, and take over the active cowboy.

### 3.3 The API drives every client

The bebop HTTP API is the product surface. The CLI is a thin client over the same generated contract, with no CLI-only behavior. Every workflow — create, observe, steer, approve, merge — must be achievable by a headless machine client, because the next clients (GUI, Linear integration) are machine clients. The API is designed first; the CLI follows.

### 3.4 The bounty client is pluggable

Bebop owns bounty lifecycle and attachment capabilities, but it does not own a single presentation layer.

Possible clients include:

- the MVP CLI;
- SSH (mosh later);
- the tmux cockpit;
- a future OpenCode-web-based cockpit;
- a future desktop or web dashboard;
- a future Linear integration;
- third-party agent multiplexers.

### 3.5 Swordfish is deterministic software

Swordfish owns the workflow state machine. Seats perform reasoning and code work, but no model context window is the authoritative durable workflow state.

### 3.6 Independent gates examine exact commits

Validation, review, QA, CI, and evidence are tied to an exact commit SHA. Any new commit invalidates every downstream result.

### 3.7 High-value authority stays outside the sandbox

Bebop, not the sandbox, owns:

- exe.dev account authority;
- pull-request creation and merge authority;
- lifecycle deletion;
- durable bounty metadata;
- external evidence publication;
- credentials that can mutate protected branches or external systems.

### 3.8 Repositories define how they are built and verified

Repositories provide system-specific setup, validation, QA, and evidence hooks under `.bebop/`. Swordfish executes those hooks independently from ein.

### 3.9 Human steering is normal

An autonomous run is not an opaque batch job. The user can observe it continuously, take over the active cowboy, and hand the unchanged stage back to Swordfish explicitly.

### 3.10 Refuse rather than pretend

Where an external authority a route depends on does not exist yet, the route refuses rather than returning a plausible success. `merge` refuses without GitHub, because answering anything else would claim a side effect that never happened; the evidence route reports an empty bundle list for the same reason; the fake lifecycle provider creates deterministic local VM records and is honest about being local rather than imitating a provisioned computer.

A stub that returns a plausible success is indistinguishable from working software right up until it matters, and every caller written against it encodes the lie.

## 4. Goals

The MVP must:

- create an isolated exe.dev VM for a bounty;
- attach configured GitHub, LLM, and context integrations without placing reusable secrets in the VM;
- return structured attachment metadata, including SSH and private preview URLs;
- provide a cockpit containing Swordfish status, visible seat panes, and free shell panes;
- run a persistent primary OpenCode seat for ein;
- let the user clarify work interactively before autonomy begins;
- create and confirm a structured effective specification through `/set-spec`, then explicitly `/handoff`;
- transfer exclusive control of ein's seat to Swordfish;
- monitor OpenCode through its server API and event stream;
- authoritatively reject human prompts to a Swordfish-controlled seat via the bebop OpenCode plugin;
- detect both explicit workflow signals and harness idle/completion events;
- run authoritative repository validators from a clean, SHA-pinned worktree;
- run pull-request CI and independent code review;
- run QA only after CI and review pass;
- prepare a clean, repository-defined QA environment;
- return review, CI, and QA findings to ein's original seat;
- repeat the loop after revisions;
- enforce configurable attempt, turn, and wall-clock constraints;
- surface exhausted constraints as `needs_attention`;
- preserve durable bounty state across process restarts;
- upload evidence blobs from Swordfish to bebop;
- expose bounty status through the bebop API and CLI, including a live SSE event stream with cursor replay;
- require explicit user authorization to merge;
- deprovision the bounty VM after successful merge or explicit destruction.

## 5. Non-goals

The MVP will not:

- design or coordinate large multi-PR projects;
- automatically decompose a project into child bounties;
- provide a first-party web dashboard;
- use Linear as the primary frontend;
- provide built-in email, Slack, Linear, or push notifications;
- implement Daytona or another compute backend;
- support any harness other than OpenCode (no adapter layer exists; a harness switch is an accepted rewrite of Swordfish's integration layer);
- expose public preview URLs;
- automatically deploy application code;
- verify production outcomes after deployment;
- maintain a global product-requirements registry;
- automatically merge a pull request;
- provide multitenant billing, enterprise RBAC, or organization administration;
- guarantee transparent recovery after permanent VM loss;
- prevent a sandbox from modifying every unprotected ref in its allowed repository;
- dynamically grant itself new external capabilities.

## 6. High-level architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                    Local or future client                     │
│                                                               │
│  bebop CLI today; GUI, Linear, or multiplexer later           │
│  bounty create · list · status · attach · evidence            │
│  approve-config · merge · stop · destroy   (all --json)       │
└──────────────────────────────┬────────────────────────────────┘
                               │ HTTPS API (private URL, bearer tokens)
                               ▼
┌───────────────────────────────────────────────────────────────┐
│              exe.dev master VM: bebop (provisioner)           │
│                                                               │
│  Caddy reverse proxy                                          │
│  Versioned API/worker containers (Effect, blue/green)         │
│  Bounty lifecycle and status projection · SSE event feed      │
│  exe.dev provisioning                                         │
│  GitHub branch, PR, CI-polling, and merge authority           │
│  Evidence ingestion                                           │
│  Postgres durable state                                       │
└──────────────────────────────┬────────────────────────────────┘
                               │ exe.dev create/attach
                               │ outbound Swordfish connection
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                    One exe.dev bounty VM                      │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Cockpit (Swordfish-owned tmux)                          │  │
│  │ active seat + workflow status line + operator panes     │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Swordfish daemon (`sf`) + SQLite                              │
│  OpenCode server + bebop plugin                               │
│  Ein's worktree and seat                                      │
│  SHA-pinned clean-room worktrees                              │
│  Jet's seat (review) · Faye's seat (QA) + browser             │
│  Dev services and disposable QA state                         │
│  .bebop/ repository hooks                                     │
└───────────────────────────────────────────────────────────────┘
```

## 7. MVP build phases

### Phase 1: One manually provisioned bounty

- Prepare the bebop base image (pinned OpenCode, Swordfish, tmux, Playwright).
- Build the Swordfish daemon and `sf` CLI.
- Integrate with OpenCode server APIs and SSE.
- Build the bebop plugin: shared workflow actions, human slash-command adapters, and the lease guard.
- Create the cockpit.
- Prove interactive-to-autonomous handoff.

### Phase 2: Supervised candidate loop

- Add candidate submissions and idle recovery.
- Add clean-room worktrees.
- Add `.bebop/` validation hooks.
- Add jet's read-only review seat.
- Add clean QA setup and browser evidence (faye).
- Add revision routing to ein.
- Add constraint ledgers and takeover.

### Phase 3: The ship (bebop provisioner)

- Deploy the containerized master stack (Effect, Compose, Caddy).
- Add Postgres.
- Add exe.dev provisioning and integration attachment.
- Add outbound Swordfish connections.
- Add status projection, SSE events, bearer-token auth, and the thin CLI.
- Add attachment metadata.

### Phase 4: GitHub and evidence

- Add branch creation and draft PR lifecycle.
- Add CI polling.
- Add protected-branch security documentation.
- Add commit-bound evidence uploads and the PR-comment sink.
- Add explicit merge and deprovision flow.

### Phase 5: Reliability

- Add event replay and deduplication.
- Add restart reconciliation.
- Add blue/green master deployment.
- Add backups.
- Add VM-loss recovery.
- Add orphan cleanup and retention policies.

## 8. MVP acceptance criteria

The MVP is acceptable when this end-to-end flow succeeds:

1. The user creates a bounty from the local CLI.
2. Bebop creates one exe.dev VM and the assigned `bounty/*` branch.
3. The VM receives only the configured exe.dev integrations; OpenCode Go works through its credential-injecting HTTP proxy without exposing the reusable key.
4. The CLI returns SSH and private preview attachment metadata.
5. SSH lands in the bounty cockpit.
6. The cockpit shows a healthy bebop connection.
7. Ein's seat is running with the configured context MCPs available.
8. The user discusses a task interactively.
9. `/set-spec` produces a structured effective spec.
10. The user confirms the spec.
11. `/handoff` transfers workflow control to Swordfish without changing stage.
12. Ein's pane remains visible, but a human prompt is rejected while Swordfish controls it.
13. A prompt submitted to a leased seat by any other route is rejected by the plugin.
14. Swordfish can prompt and observe OpenCode through its server API.
15. An idle seat without a workflow signal is re-prompted once.
16. Ein submits a candidate commit.
17. Swordfish creates a clean worktree at that exact SHA.
18. Base-revision repository validators execute independently.
19. A change under `.bebop/` (or a configured privileged glob) enters `needs_attention`, and `approve-config` for that exact SHA resumes the pipeline.
20. The candidate is pushed with normal Git commands through exe.dev's integration.
21. Bebop creates or updates a draft pull request.
22. External CI (observed by polling) and jet's read-only review run.
23. A blocking CI or review result returns to ein's seat.
24. A new commit invalidates all previous results.
25. After CI and review pass, faye starts QA in a clean environment.
26. Faye can access a private preview and browser tooling.
27. Faye saves structured results and visual or recorded evidence.
28. A QA failure returns to ein and restarts the full pipeline.
29. Constraint exhaustion enters `needs_attention`.
30. A human resume extends only the exhausted constraint.
31. The user can take over the active cowboy from the cockpit.
32. Human takeover provenance is recorded.
33. Handoff explicitly returns the current stage to Swordfish; spec revision is a separate workflow action.
34. Swordfish uploads commit-bound evidence to bebop.
35. `bounty list` shows the bounty as ready only for the verified head SHA.
36. A push after readiness removes ready status.
37. If the base branch advances and the PR becomes unmergeable, the bounty returns to building with feedback and ein merges the base branch back in.
38. The sandbox cannot directly update the protected merge target.
39. Only an explicit bebop merge command squash-merges the PR.
40. A client can follow the whole flow via `GET /api/bounties/:id/events` without polling.
41. After merge, bebop marks the bounty done and deprovisions the VM.
42. Restarting Swordfish or bebop does not duplicate VMs, prompts, PRs, or merges.

## 9. Decision summary

The design commits to:

- **small-to-medium tasks first;**
- **one bounty = one VM, one crew, one branch, at most one PR;**
- **the Bebop naming system: bebop (ship/provisioner), Swordfish / `sf` (supervisor), crew seats ein/jet/faye, spike and ed reserved;**
- **exe.dev as the only bounty compute provider;**
- **an always-on exe.dev master VM for MVP convenience, with deployment-neutral seams and off-VM backups;**
- **containerized, blue/green bebop deployment with Postgres, built on the Effect ecosystem;**
- **full commitment to OpenCode — no harness abstraction; the bebop plugin is a first-class module;**
- **OpenCode's server API and SSE stream as Swordfish's integration seam;**
- **API-first: Effect-Schema contracts generate OpenAPI; the CLI is a thin client; SSE events ship in the MVP for future GUI/Linear clients;**
- **a visible, operator-shaped tmux cockpit whose plugin blocks mixed model turns and whose event stream exposes
  unexpected seat mutations;**
- **a deterministic Swordfish with local SQLite state;**
- **clean-room, SHA-pinned verification worktrees;**
- **local validation, then CI (polled) and review in parallel, then QA;**
- **full downstream invalidation after every commit;**
- **role-specific models, context, and permission profiles — the VM is the sandbox, ein runs allow-all;**
- **`.bebop/**` permanently privileged plus repo-configured globs, with SHA-pinned human approval;**
- **configurable constraints that escalate to human attention, one extra life per exhausted constraint;**
- **squash-only merges, crew authorship, conflict-gated base drift resolved by merging base back in;**
- **evidence uploaded from Swordfish to bebop, first published as a PR comment;**
- **a raw filesystem CAS behind a backend-neutral blob contract; no single-node MinIO;**
- **private previews only;**
- **exe.dev's GitHub, LLM, and generic HTTP-proxy integrations to keep reusable secrets off VMs, including faye's OpenCode Go key;**
- **protected Git branches and bebop-only merge authority;**
- **a thin CLI and no first-party dashboard; the OpenCode web UI is the intended cockpit v2;**
- **explicitly deferred large-project coordination, spike/ed roles, and Linear integration.**

The central seam is:

```text
Bebop owns computers, external authority, and bounty lifecycle.
Swordfish owns the autonomous software-delivery loop inside one bounty.
The crew's seats do the reasoning and remain directly observable and steerable.
```
