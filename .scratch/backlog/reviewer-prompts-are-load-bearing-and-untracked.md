# Reviewer prompts are load-bearing and untracked

[Cowboys approve or reject, and a rejection carries notes (ADR 0050)](../../docs/adr/0050-cowboys-approve-or-reject-and-a-rejection-carries-notes.md)
stores one bit and instructs richly, which is deliberate: swapping a reviewer prompt should not mean reworking
bebop or Swordfish, and an approval pipeline genuinely does not care how a reviewer reached its verdict.

The cost is that the prompt is now where the review policy lives, and nothing versions it, diffs it, or ties a
verdict to the prompt that produced it. Two bounties reviewed a month apart can be graded by different standards
with nothing in the evidence saying so.

Not a priority. Worth thinking through if prompt changes ever start explaining a change in outcomes — the
question is probably whether a verdict records which prompt revision produced it, not whether prompts get a
management system.
