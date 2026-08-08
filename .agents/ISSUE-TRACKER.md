# Issue tracker: local Markdown

Everything this repo tracks lives as Markdown under `.scratch/`. It is **committed**, not ignored — the tracker
is the canonical one for this repo, and tracker edits are commits like any other. Expect them in review.

This system is scaffolding for _building_ bebop, and deliberately not part of bebop itself: a user brings their
own planning system and hands off to a bounty once work is scoped enough to run autonomously.
[`CONTEXT.md`](../CONTEXT.md) describes the product, and nothing here belongs in it.

## What this tracker is for

**It is an in-the-moment tool, not an audit.** It answers one question: _what has been committed to being
worked on now, and has not yet been finalized into the repo?_ Finalized means landed as code, an ADR, a
`CONTEXT.md` entry, a capability doc, a gotcha, or general docs.

The consequence is the rule that governs everything below:

> **A ticket leaves the tracker the moment its reasoning is absorbed somewhere durable.** Not archived —
> deleted. Git remembers; the tracker does not have to.

A resolved ticket that produced an ADR is a second copy of that ADR. A build ticket whose code merged is a
second copy of the code. Keeping either turns the tracker into a history nobody reads and a frontier nobody can
see. A ticket stays only while its reasoning has no durable home yet — and that is a bug to fix by writing the
gotcha or the ADR, not a state to settle into.

So the tracker is small on purpose. If it is growing, something is not being written down properly.

## Nothing outside `.scratch/` links into `.scratch/`

This file is the only doorway. Source comments, ADRs, capability docs, the README, and `ABSTRACT.md` never cite
a ticket — the tracker is scaffolding, and durable prose must not depend on it. Cite instead:

| The thing you wanted to point at | What to cite                                                            |
| -------------------------------- | ----------------------------------------------------------------------- |
| A resolved decision              | the ADR it produced, by name and number                                 |
| An open question                 | nothing — state the question in the capability's **Still open** section |
| Shipped work                     | the capability or `docs/testing.md` describing the thing that now runs  |
| A term                           | [`CONTEXT.md`](../CONTEXT.md)                                           |

**This applies inside the tracker too.** A ticket citing another ticket that later gets absorbed leaves a dead
link, so cite the durable artifact wherever one exists. Cross-ticket links are for live tickets only.

`.agents/` is exempt — skills that operate on the tracker have to know where it is.

## The three homes

| Home        | Holds                                                                       | Leaves when                     |
| ----------- | --------------------------------------------------------------------------- | ------------------------------- |
| **backlog** | Anything noticed and not yet triaged — vague requests, bugs, nagging doubts | Triaged out                     |
| **ticket**  | One unit of committed work: a decision to settle, or a slice to build       | Its outcome is absorbed durably |
| **project** | Every ticket for one destination, plus the map of the route to it           | Its destination is reached      |

```
.scratch/
  backlog/<slug>.md          # untriaged
  tickets/<slug>.md          # triaged, belonging to no project
  <project>/
    map.md                   # Destination / Notes / Decisions so far / fog / out of scope
    tickets/<slug>.md
```

A ticket lives at top level when no project claims it, and under a project when one does. That is the only
difference between the two locations — same format, same lifecycle.

**A project is a destination somebody has committed to.** Not a folder, not a phase, not a theme — a thing
that can be reached, after which the project is over. Creating one is the rarest outcome of triage.

**Fog decides whether a map is charted, not whether a project exists.** Those are two different questions, and
conflating them is what made the earlier phase-per-project layout collapse. A live project has fog and so its
map carries Notes, **Not yet specified**, and a real frontier. A project that is real but not next gets a stub
map: Destination, one line saying it is a holding pen, and whatever tickets already belong to it. That is an
address, not a chart. Writing four full maps for work nobody will touch for months is the opposite of an
in-the-moment tool; refusing the directory entirely just forces those tickets into a live map where they lie
about what is being worked on.

**One project is live at a time.** If two claim to be, one of them is a holding pen and should say so in its
Notes.

Projects are not derived from anything in `ABSTRACT.md`. Build order lives there, in §7, as prose; what someone
has actually committed to next is a project here. Keeping those separate is deliberate — a build order that has
to be restructured every time priorities move was the previous mistake.

## Tickets cover both deciding and building

There is no separate "issue" and "brief". **A ticket is one unit of committed work, of either kind**, and which
kind it is lives in frontmatter rather than in the directory tree. Two independent axes:

|                 | **Decides** — closes as an ADR or other durable artifact | **Builds** — closes as a merged PR |
| --------------- | -------------------------------------------------------- | ---------------------------------- |
| **Interactive** | `grilling`, `prototype`                                  | —                                  |
| **Autonomous**  | `research`                                               | `build`                            |
| **Either**      | `task`                                                   | —                                  |

The five types:

- **`grilling`** — a decision settled by conversation. The default when something needs deciding.
- **`prototype`** — a decision settled by building something cheap and rough to react to.
- **`research`** — a fact a decision waits on, findable outside the working directory.
- **`task`** — manual work that must happen before a decision can be made. Signing up for a service so its API
  can be judged; provisioning access. It _does_ rather than decides, and earns its place by unblocking a
  decision rather than by delivering the destination.
- **`build`** — a PR-sized slice of the destination itself.

The discriminator between the last two:

> **A task unblocks a decision. Work that delivers the destination is a build ticket.**

If its outcome is a merged PR rather than a durable decision, it was never a decision, however small it is. And a
ticket that weighs two or more named options against their costs is a `grilling`, not a `task`, no matter how
much implementation the chosen option implies.

[The wayfinder skill](./skills/wayfinder/SKILL.md#how-to-work-each-decision-type) says how to _work_ each
deciding type — which skill to invoke, and whether a human has to be in the loop.

### The map charts decisions; the project holds both

**A map is a decisioning instrument.** It tracks the fog between here and the destination and points at the
decision tickets that clear it. `build` tickets live in the same project directory, but the map does not chart
them: no section lists them, and shipping one is not a step on the route.

**So a project outlives its map.** The map is done when no fog is left — when everything remaining is
specifiable. What remains at that point is build tickets. A finished map above six open build tickets is the
normal end state of wayfinding, not a problem, and it is the signal that the project has stopped needing
decisions and started needing PRs.

A `build` ticket is not a spec. `CONTEXT.md` reserves that word for a bounty's effective spec, distilled from
the opening conversation and confirmed by the user. A build ticket is the human-written precursor a spec comes
from — which is what lets you say "the ticket became the spec".

## Names, not numbers

Every file is named by **slug**, never an index. Slugs need no knowledge of what already exists, so people
working in parallel never collide over a number; two people choosing the same slug have found a duplicate,
which is information rather than a conflict.

The slug is the item's **identity for its whole life**, and the directory is where it currently lives. A
backlog item promoted into a project keeps its name; `git mv` moves it and the links follow.

Refer to items by their **title** in prose, narration, and a map's Decisions-so-far — never by slug or path. A
title reads at a glance; the link rides inside it.

## Triage

Move each backlog item to the **shallowest home that fits**:

1. **Delete it** — not real, already fixed, or a duplicate.
2. **`tickets/<slug>.md`** — you know what this is, and no project owns it.
3. **`<project>/tickets/<slug>.md`** — it clearly belongs to a live map.
4. **A new project** — only when you can name a destination _and_ list at least two things you can't yet
   specify. Both halves are required: one unspecifiable thing is a ticket, zero is a build ticket.

Default shallow. Promotion is cheap — `git mv` the ticket into a project directory and write the map at the
moment you actually have fog to write down.

A backlog item needs no frontmatter — being in `backlog/` _is_ the status, and triage is the move out. Adding
frontmatter is part of the move.

## File formats

Metadata lives in **YAML frontmatter**; everything else is prose. Frontmatter is delimited, so it can be decoded
against a schema the way this repo decodes anything at a seam — a bare `status:` line in the body is
indistinguishable from the same words inside a code block. The title stays the `# ` heading: it is what
[refer-by-name](#names-not-numbers) uses, and it renders.

**Backlog item** — no frontmatter at all. A title and a couple of sentences.

**Ticket** — the question or the scope in the body. The outcome is never stored on the ticket: it is written
into its durable home and the ticket is deleted on close ([Closing a ticket](#closing-a-ticket)).

```yaml
---
type: grilling # grilling | prototype | research | task | build
status: open # open | claimed
blocked-by: [some-slug, another-slug] # omit when nothing blocks it
---
```

There is no closed status: closing deletes the ticket, so `open` and `claimed` are the only statuses the tracker
needs. A `done` marker would be a second copy of the PR or ADR that already absorbed the work —
[closing a ticket](#closing-a-ticket) is deletion, not a transition.

A `build` ticket carries a mandatory **Done when** section — the proto-acceptance-criteria. An effective spec
must declare at least one, so a ticket carrying them is already spec-shaped and the handoff becomes a
distillation rather than a rewrite.

A ticket whose outcome would invalidate a capability doc says so directly under its title:

```markdown
Resolving this updates [Provisioning and attachment](../../../docs/capabilities/02-provisioning-and-attachment.md).
```

The pointer runs this way deliberately. A capability listing its open questions would have to link back into
`.scratch/`, and the person who needs the reminder is whoever picks the ticket up. This is the one direction
that stays inside the rule above, because it points out of the tracker rather than into it.

Comments and conversation history append to the bottom under a `## Comments` heading.

## Closing a ticket

Closing is deletion, and it happens in the same change that lands the work. The PR that merges the code, ADR, or
docs that absorbed the ticket is its only record — there is no second cleanup PR that appends an outcome and
marks it done. The ticket file is removed with the work it described.

Two steps, in order:

1. **Write the durable artifact**: the ADR, the capability update, the `CONTEXT.md` entry, the gotcha. A build
   ticket's outcome is the merged PR itself. This is the step that makes the tracker an in-the-moment tool
   rather than a graveyard.
2. **Delete the ticket**, and clear its slug from every `blocked-by` that names it — an absorbed blocker is not
   a blocker. Leave one line in the project map's **Decisions so far** _only_ if the decision has no durable
   home; otherwise the map cites the ADR by name and number and the ticket is simply gone.

If step 1 has nothing to write, ask whether the ticket was worth opening. If deletion feels lossy, step 1 was not
finished — find what is still only in the ticket and give it a durable home first.

## Wayfinding operations

Used by `/wayfinder`, which defers to this section for how the tracker physically works here.

- **Map**: `.scratch/<project>/map.md` — the Destination / Notes / Decisions-so-far / fog / out-of-scope body.
- **Child ticket**: a **decision** ticket at `.scratch/<project>/tickets/<slug>.md` — `grilling`, `prototype`,
  `research`, or `task`. A `build` ticket lives in the same directory but is not a child of the map and never
  appears on it.
- **Map complete**: no fog left — **Not yet specified** is empty and no decision ticket is open. Build tickets
  may still be open; that is the project continuing, not the map being unfinished.
- **Blocking**: frontmatter `blocked-by: [<slug>, <slug>]`. A slug may name any ticket in any project, since a
  decision can wait on something being built elsewhere — cross-project blocking is normal here, because the
  decision frontier runs ahead of the build frontier. A ticket is unblocked when every slug it names
  no longer exists: an absorbed blocker is a satisfied one.
- **Frontier**: scan every `tickets/` directory for tickets that are open, unblocked, and unclaimed. Rank by
  critical path — a ticket that blocks more tickets, directly or transitively, sorts first. Open `build`
  tickets outrank open decisions: something already specified and unbuilt is the answer to "what next".
  `vp run next` renders it — Build, Decide, Triage — so no file stores it.
- **Claim**: set `status: claimed` and save before any work.
- **Resolve**: follow [Closing a ticket](#closing-a-ticket).

Two sessions closing two tickets touch different files, but both may append to a `map.md` — that is where a
conflict will be.

## When a skill says "publish to the issue tracker"

Create a new file in the home that fits — `.scratch/backlog/` when it is untriaged, otherwise the `tickets/`
directory of the project it belongs to, or the top-level one when no project claims it.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the slug directly.

## Active projects

- [One bounty, end to end, locally](../.scratch/local-end-to-end-bounty/map.md) — **live.** The whole loop on a
  laptop, ending in a pull request the operator merges by hand. No exe.dev, no provisioned computer.
- [The MVP remainder](../.scratch/mvp-remainder/map.md) — stub. Everything between a working local loop and
  §8: provisioning, the deployed ship, merge authority, reliability. Its exe.dev research is being answered
  early anyway, because that unknown is long-lead.
- [Fallow cleanup](../.scratch/fallow-cleanup/map.md) — zero Fallow findings under a committed policy, then
  `fallow audit` as a PR gate. Tooling hygiene, not product work; runs alongside.
