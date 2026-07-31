# Bebop

Bebop moves a trusted local coding-agent workflow onto remote computers without losing direct access, steerability, repository context, or independent verification. This file is the project's ubiquitous language: what each term means, and which near-synonyms not to use.

Names come from the ship, crew, and world of _Cowboy Bebop_, chosen deliberately to avoid collision with vendor vocabulary — OpenCode "sessions", tmux "sessions", Linear "threads". Only reasoning agents receive character names, with two exceptions: bebop itself (the ship) and Swordfish (the smaller ship that carries the crew into a bounty). This preserves the line between agents that reason and software that governs.

## The system

**Bebop**:
The whole system, and the name of this repository.

**bebop**:
The always-on provisioner service and its CLI — the ship. It owns bounty lifecycle, all authority reaching outside a sandbox, and the canonical bounty API, and is the only actor that may merge.
_Avoid_: master (says where it runs, not what it is), server, control plane.

**Swordfish**:
The supervisor daemon inside a bounty VM, invoked as `sf`. Deterministic software, not a reasoning agent: it drives the crew, runs gates, and never owns merge authority.
_Avoid_: orchestrator, agent, runner.

**master VM**:
The exe.dev VM that bebop runs on. A deployment location, not a role — bebop assumes no locality between itself and the bounties it provisions.

## Work

**bounty**:
The top-level unit of work: one VM, one target repository, one assigned branch (`bounty/<bounty-id>`), at most one pull request, one crew.
_Avoid_: job, task, ticket, issue.

**catching the bounty**:
Merging a bounty's pull request. The only act that finishes a bounty, and it requires an explicit human command.
_Avoid_: shipping, landing, closing.

**effective spec**:
The structured snapshot of what one bounty is supposed to accomplish, distilled from the opening conversation and confirmed by the user. It must declare at least one acceptance criterion, because every gate downstream assesses the work against them.
_Avoid_: requirements, PRD, ticket description. "Spec" unqualified always means this; a PR's worth of work on Bebop itself is a **brief**.

**candidate**:
An explicit submission by ein, tied to exactly one commit SHA. Only a candidate can enter authoritative verification; a harness falling idle is not a candidate.
_Avoid_: build, submission, attempt.

**stage**:
Where a bounty sits in Swordfish's inner workflow — `implementing`, `local_validation`, `code_review`, `qa_running`, `ready`, and the exceptional states such as `needs_attention` and `blocked`. Swordfish is authoritative for the stage; bebop holds a projection of it.
_Avoid_: state, status, phase. (**status** is the compact, derived summary bebop shows to a client.)

## The crew

**crew**:
The reasoning agents aboard one bounty VM. Swordfish is not crew.

**seat**:
One long-lived OpenCode session bound to one crew role for the life of the bounty.
_Avoid_: session (collides with OpenCode and tmux), worker, slot.

**ein**:
The primary implementation agent. Holds the task conversation, edits the primary worktree, submits candidates, and revises against findings — retaining its context across the whole loop.

**jet**:
The independent code reviewer. A distinct seat with no access to ein's conversational context, read-only tools, and structured findings as its output.

**faye**:
The QA agent. Browser-driven verification of acceptance criteria against the exact candidate SHA in a clean environment. Never edits code.

**spike**:
_Reserved._ A future prototyper seat for research preceding implementation. Does not exist today; the directory of past prototypes is `prototypes/`, deliberately not named for this term.

**ed**:
_Reserved._ A future builder subagent that ein can invoke for complex subtasks. Does not exist today.

## Control

**cockpit**:
The attachment interface to a bounty — today a Swordfish-owned tmux over SSH, with a status pane, locked seat panes, and free shell panes.
_Avoid_: terminal, dashboard, console.

**attach**:
Connecting a human to a bounty's cockpit. Attaching is observation; it grants no authority to type into a leased seat.

**control lease**:
The record of which single actor — `human` or `swordfish` — may submit prompts to a given seat. Durable: taking and releasing it are recorded state transitions, not terminal modes.
_Avoid_: lock, mutex, ownership.

**takeover**:
A human claiming the control lease on a seat. Always recorded.

**handback**:
A human releasing the control lease back to Swordfish.

**intrusion**:
A message or tool execution on a leased seat that Swordfish did not originate. Recorded and escalated rather than silently absorbed.

## Verification

**gate**:
A verification gate a candidate must pass — local validation, external CI, jet's review, faye's QA. Only `blocking` findings stop a candidate.
_Avoid_: check (reserved for GitHub's checks), test, stage.

**validator**:
A repository-defined mandatory check that Swordfish runs. Checks ein ran itself are never authoritative evidence.

**clean-room worktree**:
The ephemeral worktree Swordfish pins to the exact candidate SHA for verification, sharing nothing with ein's working state.
_Avoid_: sandbox (that is the VM), clean checkout.

**hook**:
A plain executable that a target repository owns and Swordfish runs on its behalf.

**privileged path**:
A repository path whose modification by a candidate forces human approval before verification can continue.

**approve-config**:
A human approving a candidate's changes under privileged paths, recorded against that exact SHA. No autonomous path can grant it.

**readiness claim**:
Swordfish's assertion that a given commit is ready. A claim, never authority — bebop re-verifies independently before offering merge.

**evidence bundle**:
The artifacts a verification stage produced, tied to one bounty, spec revision, and candidate commit.
_Avoid_: report, results, artifacts (an artifact is one item in a bundle).

## Repository configuration

**`.bebop/`**:
The directory in a _target_ repository that declares how it is set up, validated, and QA'd. Repositories define how they are built and verified; Bebop does not guess.
