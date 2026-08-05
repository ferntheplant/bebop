# Local validation

The first gate, and the one that makes every later gate mean something. Swordfish runs your repository's
validators itself, from a worktree pinned to the exact candidate commit — not from the directory the cowboy has
been working in for the last hour.

## What you can expect

- **A clean room per candidate.** Swordfish creates an ephemeral worktree at the exact candidate SHA, with
  isolated ports and disposable service state, sharing no uncommitted files with ein's worktree. It is destroyed
  once its evidence is captured.
- **Checks ein ran itself are never authoritative.** They were useful while developing; they prove nothing about
  the commit. A cowboy verifying its own working directory can pass on files it never committed, ports it left
  running, and databases it already seeded.
- **Validators come from the base revision**, so a candidate cannot supply the checks that judge it.
- **A full record per run**: command, environment profile, start and end time, exit status, captured output,
  artifact paths, and the candidate SHA.
- **Failures come back structured**, aggregated into the feedback packet ein receives, rather than as a wall of
  log output.
- **One authoritative operation per submission.** A clean failure consumes the ein attempt that produced the
  candidate and continues the same build cycle; it is never retried automatically. An uncertain operation
  requires human `rerun validation` against the same SHA.
- **CI is the second cheap gate.** Passing local validation does not yet consume a validated-candidate slot or
  activate jet. The candidate must be pushed and pass external CI first.

## Where it stands

**Designed.** No clean-room worktree, hook execution, or validator run exists yet. The stage is modelled in the
workflow core and Swordfish can hold its result, but nothing populates it.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **17** (Swordfish creates a clean worktree at that exact SHA)
and **18** (base-revision repository validators execute independently).

## Decisions

- [Verification runs in a clean-room worktree (ADR 0015)](../adr/0015-verification-runs-in-a-clean-room-worktree.md)
  — the clean room is what makes a gate result a statement about the commit rather than about the cowboy's desk,
  and it is why only an explicit candidate can enter verification.
- [Every commit invalidates every downstream result (ADR 0016)](../adr/0016-every-commit-invalidates-every-downstream-result.md)
- [`.bebop/**` is permanently privileged (ADR 0011)](../adr/0011-the-bebop-directory-is-permanently-privileged.md)
  — why validators load from base.
- [Flaky gates are not auto-retried (ADR 0031)](../adr/0031-flaky-gates-are-not-auto-retried.md)
- [CI gates cowboy review (ADR 0040)](../adr/0040-ci-gates-cowboy-review.md)

The hook contract itself lives in [repository configuration](./07-repository-configuration.md).

## Still open

- **Repository configuration in practice** — still fog; a hook that hangs
  or a port that collides will decide how much of this stage has to change.
