---
status: open
---

# Brief: render the frontier

One command that answers "what is up next" by deriving it from `.scratch/`, so no file has to store it.

## Why

The tracker cannot render its own frontier. Today a takeable ticket is indistinguishable from a blocked one
without opening every file it names: `runtime-manifest-defect-recovery` lists a `blocked-by` whose ticket
resolved long ago, and nothing says so. The map compensated with a hand-written "the next work is …" line in
Decisions-so-far — a second copy of state that the first missed update leaves permanently wrong, which is the
thing this repo's own architectural rules forbid.

Deriving it on read is the fix. Nothing new is stored; the answer is computed from the files that already exist.

## Scope

One task — `vp run next` — printing three sections, in the order they should be considered:

1. **Build** — open briefs (`Status: open`) across `.scratch/briefs/` and every effort's `briefs/`. Specified,
   PR-sized, nothing left to decide. A non-empty section here is the answer.
2. **Decide** — per map, the tickets that are open, unclaimed, and whose every `Blocked by:` slug resolves to a
   `Status: resolved` ticket. Name each by title. Rank by **critical path**: a ticket that blocks more tickets,
   directly or transitively, sorts first — `provision-exe-dev-access` currently gates six others and should say
   so.
3. **Triage** — inbox depth, and the age of the oldest item.

Read-only. It parses each file's YAML frontmatter and never writes to `.scratch/`.

## Not in scope

- Any write path: no claiming, resolving, or creating from the command.
- A tracker abstraction. This reads this repo's Markdown layout directly.
- Replacing the map. Destination, Notes, fog, and Out-of-scope stay prose that a human reads.

## Done when

- `vp run next` prints the three sections from a clean checkout, with no arguments;
- a ticket whose blockers have all resolved appears under **Decide**, and one with an unresolved blocker does not;
- a `blocked-by` naming a slug that does not exist fails loudly rather than silently treating it as unblocked;
- the critical-path ranking is computed transitively, and is covered by a test over a fixture tracker rather than
  over the live `.scratch/`;
- an effort with no `briefs/` directory, and an empty inbox, both render without error;
- the hand-maintained "the next work is …" pointer is deleted from `.scratch/bebop-mvp/map.md`, because the
  command now derives it.
