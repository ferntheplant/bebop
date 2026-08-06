---
type: build
status: open
---

# Render the frontier

One command that answers "what is up next" by deriving it from `.scratch/`, so no file has to store it.

## Why

The tracker cannot render its own frontier, and the restructure made that worse: the
open work is spread across four `tickets/` directories, and a takeable ticket is still indistinguishable
from a blocked one without opening every file it names. An earlier map compensated with a hand-written
"the next work is …" line in Decisions-so-far — a second copy of state that the first missed update leaves
permanently wrong, which is the thing this repo's own architectural rules forbid. That line is gone; nothing
replaced it.

Deriving it on read is the fix. Nothing new is stored; the answer is computed from the files that already exist.

## Scope

One task — `vp run next` — printing three sections, in the order they should be considered:

1. **Build** — open `type: build` tickets across `.scratch/tickets/` and every project's `tickets/`. Specified,
   PR-sized, nothing left to decide. A non-empty section here is the answer.
2. **Decide** — the open, unclaimed, unblocked tickets of every other type, grouped by project. Name each by
   title. Rank by **critical path**: a ticket that blocks more tickets, directly or transitively, sorts first —
   `provision-exe-dev-access` currently gates three tickets in its own project and should say so.
3. **Triage** — backlog depth, and the age of the oldest item.

Blocker resolution searches every `tickets/` directory, since `blocked-by` crosses projects freely — the
live project's tickets can wait on research being answered early inside a holding-pen project, which is the
normal case here rather than an exception.

Read-only. It parses each file's YAML frontmatter and never writes to `.scratch/`.

## A dangling `blocked-by` means unblocked, and says so

[The tracker doc](../../.agents/ISSUE-TRACKER.md#closing-a-ticket) deletes a ticket once its outcome is absorbed
into an ADR, capability, or gotcha, and asks the closer to clear that slug from every `blocked-by` naming it. So
a slug pointing at no file has two possible causes, and they want different treatment:

- the blocker was absorbed and the closer skipped the cleanup step — the ticket **is** unblocked;
- the slug is a typo — the ticket's real blocker is unknown.

Neither should fail the command, and neither should be silent. Treat the ticket as unblocked, list it under
**Decide**, and annotate it with the dangling slug. That surfaces typos to a human without hiding takeable
work, and it doubles as a nag for closes that skipped step 4.

## Not in scope

- Any write path: no claiming, closing, or creating from the command.
- A tracker abstraction. This reads this repo's Markdown layout directly.
- Replacing the map. Destination, Notes, fog, and Out-of-scope stay prose that a human reads.

## Done when

- `vp run next` prints the three sections from a clean checkout, with no arguments;
- a ticket whose blockers are all `done` or absent appears under **Decide**, and one with an open blocker does
  not;
- a `blocked-by` naming a slug that does not exist renders the ticket as takeable **and** prints the dangling
  slug beside it;
- `blocked-by` is resolved across project directories, not just within the ticket's own project;
- the critical-path ranking is computed transitively, and is covered by a test over a fixture tracker rather
  than over the live `.scratch/`;
- a project with no `tickets/` directory, and an empty backlog, both render without error.
