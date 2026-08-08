---
type: build
status: open
---

# Swordfish pushes the candidate and requires a clean tree

Resolving this updates [Pull request and merge](../../../docs/capabilities/12-pull-request-and-merge.md).

## Background

Swordfish owns the guarantee that a candidate SHA is on GitHub, per
[The local loop runs the production assembly (ADR 0046)](../../../docs/adr/0046-the-local-loop-runs-the-production-assembly.md).
An agent may push whenever it likes — it has `git` and `gh` and is expected to use them for reading history and
pull requests — but it is never load-bearing for the candidate arriving. Swordfish pushes on every candidate,
which is a no-op when the agent already pushed that SHA, and that is the point: one code path, exercised every
time, rather than a rarely-taken branch that only runs when an agent misbehaves.

The clean-tree precondition matters because a candidate SHA is a claim about what will be validated. If the
working tree is dirty, the SHA does not describe what the agent believes it built, and both the clean-room
worktree of
[Verification runs in a clean-room worktree (ADR 0015)](../../../docs/adr/0015-verification-runs-in-a-clean-room-worktree.md)
and the pushed branch would disagree with the seat.

The check belongs **before** `candidate_submitted` is emitted, not inside the reducer: state transitions are
pure and the filesystem is not their business. That placement is also what makes the refusal free — a rejected
submission never reaches the reducer, and `validatedCandidatesConsumed` is charged when CI passes rather than at
submission (`packages/workflow/src/core.ts`), so a dirty-tree refusal costs no validated-candidate slot. It does
cost turns in the current attempt, which is correct: the agent spent one.

## Scope

- Confirm the working tree is clean at candidate submission, and refuse back to ein with feedback naming what is
  uncommitted when it is not.
- Push the candidate SHA to the assigned branch, idempotent when the remote already points at it.
- Push through ordinary Git with the machine's ambient credentials, so attaching exe.dev's integration later
  swaps the credential source and leaves the invocation unchanged.
- Distinguish a push refused by a ruleset from a transient network failure — the first is a defect in what was
  attempted, the second is worth retrying.

## Done when

- A candidate submitted with a clean tree ends up on the assigned branch, whether or not the agent already
  pushed it.
- A candidate submitted with a dirty tree is refused, ein receives feedback, and the validated-candidate count
  is unchanged.
- A candidate whose SHA is already the remote tip completes without a second push and without an error.
- Push failure, refusal, and restart mid-push are tested.
- `vp run ready` passes.
