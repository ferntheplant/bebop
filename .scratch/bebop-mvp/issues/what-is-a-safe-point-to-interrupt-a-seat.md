---
type: grilling
status: resolved
---

# What is a safe point to interrupt a seat, and what does takeover do at each stage?

## Question

The provisional protocol is `session.abort` → wait for the idle or aborted event → record the last message ID,
with takeover permitted only at that point unless forced. "Safe point" is doing a lot of work in that
sentence and has never been defined per stage.

Settle:

- what a safe point means when the seat is mid-tool-call, mid-file-write, or mid-`git` operation — an aborted
  turn that leaves a half-written worktree is not safe in the sense that matters;
- what `--force` actually does, and what state is guaranteed after it;
- whether takeover is legal in every stage or only some — taking over ein during QA means the candidate under
  test can change while faye is testing it;
- what the human sees while the abort is in flight, given that
  [the guard's message never reaches the HTTP caller (ADR 0009)](../../../docs/adr/0009-the-control-lease-is-enforced-in-four-layers.md);
- what happens to an in-flight gate when its seat is taken over, and whether its result is still admissible;
- whether handback resumes the interrupted turn, restarts the stage, or requires a fresh spec confirmation.

## Answer

"Safe point" is retired. A takeover completes through a **quiescent handoff**: the previous actor is no longer
executing before the new actor receives access. Quiescence does not promise rollback, a clean worktree, an atomic
tool call, or a complete Git operation. The human inherits and inspects whatever state the interrupted turn left
behind.

### Taking over

A takeover request durably records its episode, leaves stage unchanged, sets the workflow controller and active
seat lease to human, stops autonomous wall-clock accounting, and prevents Swordfish from originating more work.
The pane remains input-disabled and no human seat credential is issued yet, so the interrupted turn and the
human never write concurrently.

Swordfish asks OpenCode to abort, then waits until the server reports the seat idle and no tracked operation for
that seat remains active. The abort response or `MessageAbortedError` alone is not proof: OpenCode exposes no
typed aborted event and promises no tool rollback. The grace duration is part of runtime-manifest configuration
and defaults to 10 seconds.

If quiescence is not proven before the grace deadline, Swordfish automatically takes the forced path. `--force`
means only "skip the graceful window"; a normal takeover never silently fails merely because abort was slow.
The forced path terminates the selected seat's OpenCode process group and tracked children, verifies the old
listener and processes are gone, and restarts the seat against the same private OpenCode database. Human access
is enabled only after that succeeds.

Forced interruption still does not undo partial files, lock files, detached processes outside the tracked tree,
or external side effects. If termination, verification, or restart fails, workflow control stays human with
access marked unavailable and an attention reason. Swordfish never reclaims control from uncertain state.

The operation and its progress are durable and idempotent. Restarting Swordfish reconciles the recorded episode
and process identities rather than issuing a second abort, restart, credential, or prompt. Cockpit status and
events expose the unchanged current stage, seat, grace deadline, graceful-versus-forced path, access readiness,
and any degraded result. The takeover command succeeds only when access is ready.

At most one cowboy seat is active. It may be taken over in any stage that has one, except `cancelling`,
`cancelled`, or `failed`; takeover is refused when deterministic work has no active cowboy, and once cancellation
begins, cancel takes precedence.

### Gates and parallel work

Deterministic operations and external CI may finish while the workflow controller is human. There is no other
active cowboy seat. Swordfish starts no new cowboy operation until handoff.

Taking over a seat revokes that seat's interrupted automated operation, so a late result from the old operation
is inadmissible. A human may complete a pending jet review or faye QA against the same candidate and spec
revision; a result completed while its seat is human-controlled is valid with `human_steered` provenance. If no
human result completes, handoff starts a fresh automated gate operation. A clean post-handoff rerun is
`automated` again.

Completed gates on other seats remain statements about their pinned candidate. Human edits do not invalidate a
candidate merely because they happened during takeover, but reconciliation emits the ordinary full invalidation
if the assigned branch head, candidate commit, or effective-spec revision changed.

### Handing off

Handoff is a pure control release and never changes stage. If the effective spec changed, the human first invokes
`reopen-spec` and `set-spec`; those workflow actions retain human control until a later handoff.

Handoff first disables human input, rotates any seat credential issued by `sf attach`, restarts the seat when
rotation requires it, and reconciles OpenCode, tracked processes, Git, candidate, and gate state. Only then does
one transaction return the workflow controller and active seat lease to Swordfish. An aborted turn is never
resumed: Swordfish starts a fresh cowboy operation for the unchanged stage unless the human already completed
its workflow action.

If reconciliation cannot prove a resumable state, handoff fails closed and leaves workflow control human.
Takeover pauses autonomous wall-clock accounting but refunds nothing already consumed: turns, provider cost,
completed rounds, and prior elapsed autonomous time remain in the constraint ledger. The exact extension policy
for constraint exhaustion remains with the constraints ticket.
