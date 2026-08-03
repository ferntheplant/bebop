# What is a safe point to interrupt a seat, and what does takeover do at each stage?

Type: grilling
Status: resolved

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

A takeover request durably records its episode, immediately enters `human_controlled`, transfers the selected
seat's lease to the human, stops autonomous wall-clock accounting, and prevents Swordfish from originating more
work. The pane remains input-disabled and no human credential is issued yet, so the interrupted turn and the
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
or external side effects. If termination, verification, or restart fails, the bounty stays `human_controlled`
with access marked unavailable and an attention reason. Swordfish never reclaims the lease from uncertain
state.

The operation and its progress are durable and idempotent. Restarting Swordfish reconciles the recorded episode
and process identities rather than issuing a second abort, restart, credential, or prompt. Cockpit status and
events expose the seat, prior and resumable stage, grace deadline, graceful-versus-forced path, access readiness,
and any degraded result. The takeover command succeeds only when access is ready.

One seat per bounty may be human-controlled at a time. Any existing seat may be taken over in any stage except
`cancelling`, `cancelled`, or `failed`; once cancellation begins, stop takes precedence.

### Gates and parallel work

Work already running on other seats and external CI may finish while the bounty is `human_controlled`, and its
results may advance the suspended stage. Swordfish starts no new autonomous operation until handback.

Taking over a seat revokes that seat's interrupted automated operation, so a late result from the old operation
is inadmissible. A human may complete a pending jet review or faye QA against the same candidate and spec
revision; a result completed while its seat is human-controlled is valid with `human_steered` provenance. If no
human result completes, handback starts a fresh automated gate operation. A clean post-handback rerun is
`automated` again.

Completed gates on other seats remain statements about their pinned candidate. Human edits do not invalidate a
candidate merely because they happened during takeover, but reconciliation emits the ordinary full invalidation
if the assigned branch head, candidate commit, or effective-spec revision changed.

### Handing back

The human explicitly declares whether the effective spec changed; ein does not infer this after control has
already been released.

- **Unchanged:** handback first disables human input, rotates any credential issued during the control episode,
  restarts the seat when rotation requires it, and reconciles OpenCode, tracked processes, Git, candidate, and
  gate state. Only then does one transaction return the lease to Swordfish and restore the latest resumable
  stage. An aborted turn is never resumed: Swordfish starts a fresh prompt or gate operation when that stage
  needs one, unless the human already completed the gate.
- **Changed:** the bounty remains human-controlled until the user confirms a revised effective spec. `set_spec`
  persists the new revision, invalidates the old candidate and gates, revokes human access, and transfers control
  as its existing atomic handoff.

If unchanged-spec reconciliation cannot prove a resumable state, handback fails closed and leaves the bounty
human-controlled. Takeover pauses autonomous wall-clock accounting but refunds nothing already consumed: turns,
provider cost, completed rounds, and prior elapsed autonomous time remain in the constraint ledger. The exact
extension policy for a takeover caused by constraint exhaustion remains with the constraints ticket.
