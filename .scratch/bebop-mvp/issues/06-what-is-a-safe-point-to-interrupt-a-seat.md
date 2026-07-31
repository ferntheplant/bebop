# What is a safe point to interrupt a seat, and what does takeover do at each stage?

Type: grilling
Status: open

## Question

The provisional protocol is `session.abort` → wait for the idle or aborted event → record the last message ID,
with takeover permitted only at that point unless forced (`docs/design/SYSTEM.md` §11.5, §16.2). "Safe point"
is doing a lot of work in that sentence and has never been defined per stage.

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
