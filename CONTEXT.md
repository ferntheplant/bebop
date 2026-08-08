# Bebop

Bebop moves a trusted local coding workflow onto remote computers without losing direct access, steerability, repository context, or independent verification. This file is the project's ubiquitous language: what each term means, and which near-synonyms not to use.

Names come from the ship, crew, and world of _Cowboy Bebop_, chosen deliberately to avoid collision with vendor vocabulary — OpenCode "sessions", tmux "sessions", Linear "threads". Only reasoning cowboys receive character names, with two exceptions: bebop itself (the ship) and Swordfish (the smaller ship that carries the crew into a bounty). This preserves the line between cowboys that reason and software that governs.

## The system

**Bebop**:
The whole system, and the name of this repository.

**bebop**:
The always-on provisioner service and its CLI — the ship. It owns bounty lifecycle, all authority reaching outside a sandbox, and the canonical bounty API, and is the only actor that may merge.
_Avoid_: master (says where it runs, not what it is), server, control plane.

**Swordfish**:
The supervisor daemon inside a bounty VM, invoked as `sf`. Deterministic software, not a cowboy: it drives the crew, runs gates, and never owns merge authority.
_Avoid_: orchestrator, agent, runner.

**master VM**:
The exe.dev VM that bebop runs on. A deployment location, not a role — bebop assumes no locality between itself and the bounties it provisions.

**runtime manifest**:
The immutable bebop-owned identity of the software environment assigned to a bounty: an exact VM image digest
and Swordfish release. The Swordfish release pins internal dependencies such as OpenCode; status and evidence
refer to the manifest rather than treating each dependency as independently mutable bounty state.
_Avoid_: evidence manifest (describes one evidence bundle), version (too narrow).

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

**validated candidate**:
A candidate approved by local validation and external CI and admitted to jet's review. Candidates rejected
by either consume ein attempts but not the effective spec's validated-candidate allowance;
rerunning a gate against the same SHA does not create another validated candidate.
_Avoid_: candidate (includes submissions that have not passed validation and CI), approved candidate.

**build cycle**:
Ein's work from receiving a confirmed spec or downstream rejection until local validation and external CI both
approve one candidate. A build cycle may contain multiple ein attempts and candidates either gate rejected. A
review or QA rejection starts a new build cycle under the same effective spec revision.
_Avoid_: candidate (does not exist until submitted), revision (the effective spec may be unchanged).

**stage**:
A position in the state machine Swordfish and bebop use to track progress — `implementing`, `local_validation`,
`pushed_candidate`, `pr_ci`, `code_review`, `qa_preparing`, `qa_running`, `evidence_upload`, `ready`, `revision`,
and exceptional stages such as `needs_attention`, `cancelling`, and `errored`. Stage says what work is happening, not who
controls it; Swordfish is authoritative and bebop holds a projection. A stage is a location, not a checkpoint —
several stages exist that no candidate is judged at, which is why a **gate** is a separate term.
_Avoid_: state, status, phase, gate. (**status** is the compact, derived summary bebop shows to a client.)

**assignment**:
The bounded piece of autonomous work one cowboy is given, and the thing an attempt allowance is spent from —
`building` for ein, `review` for jet, `qa` for faye. Derived from the acting cowboy's role, so an attempt with no
cowboy is unrepresentable. What resets the allowance differs by assignment rather than by cowboy: ein's per build
cycle, jet's and faye's per candidate. An assignment is not a **gate** — jet's and faye's line up with one, but
ein has an assignment and no gate, because ein is not a checkpoint.
_Avoid_: scope (too general), run, job, role (the cowboy, not its work).

**attempt**:
One Swordfish-controlled activation of one cowboy for one assignment. It starts with Swordfish's first prompt and
includes idle re-prompts and process restarts. `set-blocked` followed by `resume`, or an exhausted attempt revived
by human `continue`, preserves the attempt while attention time pauses its wall clock. Ein may have many attempts
in its durable seat; every jet and faye attempt gets a fresh seat. Handoff after takeover starts a new attempt.
It also ends when control passes to a human, when human `rerun` abandons it, or when the workflow cancels or
errors. An attempt is spent when the cowboy **hands something back** — a completion, an exhausted watchdog, or a
result the gate could not use. Nudging a cowboy that is still working spends nothing, which is why an idle
re-prompt sits inside one attempt rather than starting another. An attempt **succeeds** or **fails**; failing
means it did not produce what it was for, with exhaustion one reason among several.
_Avoid_: seat (the durable OpenCode session), turn (one model interaction within an attempt), run, assignment
(the work; an attempt is one try at it).

**turn**:
One completed model step within an autonomous cowboy attempt. A response that requests tools and a response that
finishes with prose or a workflow action each consume one turn; provider transport retries and failed requests
do not. One Swordfish prompt may produce many turns.
_Avoid_: prompt, provider request.

**attempt wall clock**:
Real elapsed time from Swordfish's first prompt until the attempt ends, including tools, retries, idle grace, and
process downtime recovered after restart. Human control, deterministic gates, external waits, and time in
`needs_attention` are outside an attempt wall clock.
_Avoid_: model time, active compute time.

**constraint profile**:
The repository-owned limits on validated candidates per effective spec, attempts per assignment, and turns and
wall clock per attempt — three nested **allowances**, each of which fails by exhaustion in the same sense.
Deliberately not "cycles": a **build cycle** is one specific span of ein's work. Exhausting an allowance is never
terminal; it raises `constraint_exhausted` and asks a human. Swordfish reads the profile from the base revision and freezes it for the
bounty; omitted values use Bebop defaults. Candidate changes cannot enlarge their own profile.
_Avoid_: effective-spec constraints (describe the desired work), runtime manifest (identifies software), budget.

## The crew

**crew**:
The cowboys aboard one bounty VM. Swordfish is not crew.

**cowboy**:
A personified reasoning member of the crew, such as ein, jet, or faye. A cowboy may occupy a seat and request
role-valid workflow actions; Swordfish remains authoritative for every transition.
_Avoid_: agent (collides with OpenCode and wrongly includes deterministic Swordfish).

**seat**:
A human-addressable OpenCode session occupied by a cowboy and available for takeover. Nested subagent sessions
are not seats. A seat may become inactive and later be reactivated; ein keeps one for context continuity, while
each jet and faye attempt receives a fresh one.
_Avoid_: session (collides with OpenCode and tmux), worker, slot.

**ein**:
The primary implementation cowboy. Holds the task conversation, edits the primary worktree, submits candidates, and revises against notes — retaining its context across the whole loop.

**jet**:
The independent review cowboy. Each attempt gets a fresh seat with no access to ein's conversational context, read-only tools, and a verdict with notes as its output.

**faye**:
The QA cowboy. Each attempt gets a fresh seat for browser-driven verification of acceptance criteria against the exact candidate SHA in a clean environment. Never edits code.

**spike**:
_Reserved._ A future prototyper seat for research preceding implementation. Does not exist today; the directory of past prototypes is `prototypes/`, deliberately not named for this term.

**ed**:
_Reserved._ A future builder subagent that ein can invoke for complex subtasks. Does not exist today.

## Control

**cockpit**:
The attachment interface to a bounty — today a Swordfish-owned tmux over SSH, with managed seat windows, a
workflow status line, and operator-shaped shell panes and windows.
_Avoid_: terminal, dashboard, console.

**attach**:
Connecting a human to a bounty's cockpit. Attaching is observation; it grants no authority to type into a leased seat.

**control lease**:
The enforcement at the harness that only one actor submits model turns to the active seat. It is derived from
the workflow controller rather than stored per seat: a seat does not carry its own owner, because two records of
who is driving can disagree.
_Avoid_: lock, mutex, ownership, lease owner (retired with the per-seat record).

**workflow controller**:
The actor — `human` or `swordfish` — responsible for directing the current stage. Control is orthogonal to stage
and follows human-requested transitions until handoff; the active seat's control lease enforces it at the harness.
_Avoid_: stage owner (Swordfish remains authoritative for workflow state).

**takeover**:
A human claiming workflow control through a quiescent handoff of the active seat. Always recorded and refused
when no cowboy seat is active.

**handoff**:
A human releasing workflow control to Swordfish without changing stage. Swordfish resumes directing any active
cowboy seat.
_Avoid_: handback.

**operator credential**:
A per-bounty secret proving that a local `sf` mutation came from the human operator adapter rather than a cowboy
process in the same VM. Bebop holds its authority; Swordfish receives only a verifier.
_Avoid_: password (describes representation, not authority), proof of humanity.

**quiescent handoff**:
A control transfer in which the previous actor is no longer executing before the next actor receives access. It
does not promise rollback, a clean worktree, or atomic completion of an interrupted tool.
_Avoid_: safe point (implies consistency that cannot be proved).

**intrusion**:
A message or tool execution on a leased seat that Swordfish did not originate. Recorded and escalated rather than silently absorbed.

**active cowboy**:
The single cowboy seat currently being driven. At most one exists at a time, and a deterministic stage — local
validation, the CI poll, evidence upload — legitimately runs with none. Which one it is says nothing about who
is driving it; that is the workflow controller.
_Avoid_: current seat (a bounty keeps many seats; only one is active), lease holder.

**attention record**:
One reason a bounty stopped: a kind and a human-readable reason. Its kind determines which **resolutions** may
clear it, so status can print the exact command that applies rather than a reason a human must interpret. More
than one may be outstanding at a time — a later reason never supersedes an earlier one, at most one is held per
kind, and the suspended stage is recorded once for the workflow rather than on each record.
_Avoid_: error, alert, attention reason (the bare string this replaced).

**resolution**:
A named action permitted to clear an attention record — `resume`, `continue`, `rerun`, `takeover`, `cancel`, or
bebop-side `approve-config`. Derived from the record's kind rather than stored with it, so a record can never
offer an exit its kind forbids. A resolution clears every outstanding record that permits it and no others, and
the workflow resumes only once none remain: a `resume` alongside an exhausted budget clears the reason it may
and leaves the budget suspended. `resume` changes no allowance; reviving an exhausted attempt is a grant, and is
therefore `continue` or `rerun`.
_Avoid_: fix, remedy, unblock.

## Verification

**gate**:
One of the four points where a candidate can be stopped — local validation, external CI, jet's review, faye's QA. Every gate **approves** or **rejects**; the deterministic two reach that verdict without judgement, but the consequence is identical. Evidence upload is not a gate: it can only break.
_Avoid_: check (reserved for GitHub's checks), test, stage (a position, not a checkpoint); and `passed`/`failed` as a gate's recorded outcome — it approves or rejects. Prose may still say CI passed.

**verdict**:
A gate's binary decision about one candidate: **approve** or **reject**. Jet declares its verdict; faye's is derived from its scenarios, where any failure rejects; local validation and CI reach theirs deterministically. A cowboy's verdict _is_ its gate's outcome, not a second thing kept in agreement with it.
_Avoid_: accept (retired), block, sign off, pass/fail.

**note**:
One item of feedback attached to a verdict — a markdown body, optionally anchored to a file and line or to evidence artifacts. A rejection must carry notes; an acceptance may, and those are kept with the candidate. Notes carry no severity: the verdict is the only graded thing.
_Avoid_: finding (retired with per-item severity), comment, issue.

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
