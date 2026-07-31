# What are the default constraints, and what happens when one is exhausted?

Type: grilling
Status: open

## Question

`docs/design/SYSTEM.md` §15 carries provisional values for turn budgets, wall-clock budgets, and attempt
counts, plus the rule that exhaustion enters `needs_attention` and a human `retry` grants exactly one more
life for the exhausted constraint only.

Settle:

- the actual numbers, and what evidence would justify each — a turn budget picked by feel will either strangle
  legitimate work or fail to catch a loop;
- whether budgets are per stage, per candidate, or per bounty, and how a revision loop accumulates against
  them;
- what "one extra life" means when two constraints are exhausted at once;
- whether cost belongs in the ledger alongside turns and wall-clock, given that token spend per seat is already
  in the observability floor;
- what the user sees at exhaustion, and whether the bounty holds its VM while waiting for a human — a bounty
  parked in `needs_attention` overnight is a running computer.
