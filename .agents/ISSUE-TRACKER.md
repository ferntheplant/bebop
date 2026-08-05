# Issue tracker: local Markdown

Everything this repo tracks lives as Markdown under `.scratch/`. It is **committed**, not ignored — the tracker
is the canonical one for this repo, and tracker edits are commits like any other. Expect them in review.

This system is scaffolding for _building_ bebop, and deliberately not part of bebop itself: a user brings their
own planning system and hands off to a bounty once work is scoped enough to run autonomously.
[`CONTEXT.md`](../CONTEXT.md) describes the product, and nothing here belongs in it.

## Nothing outside `.scratch/` links into `.scratch/`

This file is the only doorway. Source comments, ADRs, capability docs, the README, and `ABSTRACT.md` never cite a
ticket or a brief — the tracker is scaffolding, and durable prose must not depend on it. Cite instead:

| The thing you wanted to point at | What to cite                                                            |
| -------------------------------- | ----------------------------------------------------------------------- |
| A resolved issue                 | the ADR it produced, as `("Title" (ADR NNNN))`                          |
| An open question                 | nothing — state the question in the capability's **Still open** section |
| A shipped brief                  | the capability or `docs/testing.md` describing the thing that now runs  |
| A term                           | [`CONTEXT.md`](../CONTEXT.md)                                           |

A resolved ticket that produced no ADR and no capability change was not worth citing. An open question written as
a plain question survives the tracker being reorganised; a link to `.scratch/…/issues/foo.md` does not.

`.agents/` is exempt — skills that operate on the tracker have to know where it is.

## The four homes

| Home       | Holds                                                                          | Closed by                        |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------- |
| **inbox**  | Anything discovered and not yet triaged — vague requests, bugs, nagging doubts | Being triaged out                |
| **issue**  | A decision needing grilling, research, or a prototype to settle                | An `## Answer`, sometimes an ADR |
| **brief**  | Work scoped enough to start a bounty on — autonomously implementable           | A merged PR                      |
| **effort** | A map from vague idea to built system, cutting through fog                     | No fog left                      |

```
.scratch/
  inbox/<slug>.md            # untriaged
  issues/<slug>.md           # standalone decision — belongs to no map
  briefs/<slug>.md           # standalone buildable work — most bug fixes
  <effort>/
    map.md                   # Destination / Notes / Decisions so far / fog
    issues/<slug>.md
    briefs/<slug>.md
```

The first three exist at top level for standalone work, and under an effort when they belong to one.

**An effort exists iff it has a map; a map exists iff there is fog.** Creating one is the rarest outcome of
triage, not the default. A directory with a single brief in it is not an effort — it is a brief.

## Names, not numbers

Every file is named by **slug**, never an index. Slugs need no knowledge of what already exists, so people
working in parallel never collide over a number; two people choosing the same slug have found a duplicate, which
is information rather than a conflict.

The slug is the item's **identity for its whole life**, and the directory is where it currently lives. An inbox
item promoted into an effort keeps its name; `git mv` moves it and the links follow.

Refer to items by their **title** in prose, narration, and the map's Decisions-so-far — never by slug or path.
A title reads at a glance; the link rides inside it.

## Triage

Move each inbox item to the **shallowest home that fits**:

1. **Delete it** — not real, already fixed, or a duplicate.
2. **`briefs/<slug>.md`** — you know what to build. Most bug fixes and small features stop here.
3. **`issues/<slug>.md`** — it needs deciding, but belongs to no larger destination.
4. **`<effort>/issues/` or `<effort>/briefs/`** — it clearly belongs to a live map.
5. **A new effort** — only when you can name a destination _and_ list at least two things you can't yet specify.
   Both halves are required: one unspecifiable thing is an issue, zero is a brief.

Default shallow. Promotion is cheap — `git mv` the brief into an effort directory and write the map at the
moment you actually have fog to write down. Guessing "effort" at triage time means writing a map before you can
see anything, which is the one thing wayfinding says not to do.

An inbox item needs no `Status:` — being in `inbox/` _is_ the status, and triage is the move out.

## File formats

Metadata lives in **YAML frontmatter**; everything else is prose. Frontmatter is delimited, so it can be decoded
against a schema the way this repo decodes anything at a seam — a bare `Status:` line in the body is
indistinguishable from the same words inside a code block. The title stays the `# ` heading: it is what
[refer-by-name](#names-not-numbers) uses, and it renders.

**Inbox item** — no frontmatter at all. A title and a couple of sentences; if it needs more than that, it is
already sharp enough to be an issue. A bug report should carry a high-level repro wherever one is possible.

**Issue** — the question in the body, and the answer appended under `## Answer` on resolution.

An issue or brief whose resolution would invalidate a capability doc says so directly under its title:

```markdown
Resolving this updates [Provisioning and attachment](../../../docs/capabilities/02-provisioning-and-attachment.md).
```

The pointer runs this way deliberately. A capability listing its open questions would have to link back into
`.scratch/`, and the person who needs the reminder is whoever picks the ticket up — not whoever reads the
capability. This is the one direction that stays inside the rule above, because it points out of the tracker
rather than into it.

```yaml
---
type: grilling # research | prototype | grilling | task
status: open # open | claimed | resolved
blocked-by: [some-slug, another-slug] # omit when nothing blocks it
---
```

`type` records how the question gets settled — the [wayfinder skill](./skills/wayfinder/SKILL.md#ticket-types)
defines each one. `task` is the one that does rather than decides, and the discriminator is what it delivers:

> **A task unblocks a decision. Work that delivers the destination is a brief.**

Signing up for a service so its API can be judged is a task. Building the thing the map is pointed at is a brief,
however small — if it closes with a merged PR rather than an `## Answer`, it was never an issue. A ticket that
weighs two or more named options against their costs is a `grilling`, not a task, no matter how much
implementation the chosen option implies.

**Brief** — what one PR is meant to build, and a mandatory **Done when** section. That section is the
proto-acceptance-criteria: an effective spec must declare at least one, so a brief carrying them is already
spec-shaped and the handoff becomes a distillation rather than a rewrite.

```yaml
---
status: open # open | shipped
---
```

A brief is not a spec. `CONTEXT.md` reserves that word for a bounty's effective spec, which is distilled from the
opening conversation and confirmed by the user. A brief is the human-written precursor a spec comes from —
keeping both words is what lets you say "the brief became the spec".

Comments and conversation history append to the bottom of a file under a `## Comments` heading.

Briefs and issues stay put once closed. They are history, not authority; anything in one still worth defending
months later belongs in an [ADR](../docs/adr/).

## When a skill says "publish to the issue tracker"

Create a new file in the home that fits — `.scratch/inbox/` when it is untriaged, otherwise the issue or brief
directory of the effort it belongs to, or the top-level one when it belongs to no effort.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the slug directly.

## Wayfinding operations

Used by `/wayfinder`, which defers to this section for how the tracker physically works here.

- **Map**: `.scratch/<effort>/map.md` — the Destination / Notes / Decisions-so-far / fog body.
- **Child ticket**: `.scratch/<effort>/issues/<slug>.md`, with the question in the body. Frontmatter `type`
  records the ticket type (`research` / `prototype` / `grilling` / `task`); `status` records `open` / `claimed` /
  `resolved`.
- **Blocking**: frontmatter `blocked-by: [<slug>, <slug>]`. A slug may name an issue or a brief, since a decision
  can wait on something being built. A ticket is unblocked when every slug it names has reached its home's
  terminal status — `resolved` for an issue, `shipped` for a brief.
- **Frontier**: scan `.scratch/<effort>/issues/` for tickets that are open, unblocked, and unclaimed. There is no
  numeric tiebreak — prefer whatever sits on the critical path, and name those tickets when you finish a session.
- **Claim**: set `status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `status: resolved`, then append a context
  pointer (gist plus link) to the map's Decisions-so-far in `map.md`.

Two sessions resolving two tickets touch different files, but both append to `map.md` — that is where a conflict
will be.

## Active efforts

- [Bebop MVP](../.scratch/bebop-mvp/map.md) — the route from the current control plane to a merged bounty.
- [Fallow cleanup](../.scratch/fallow-cleanup/map.md) — zero Fallow findings under a committed policy, then
  `fallow audit` as a PR gate.

Shipped briefs stay under the effort that produced them — see
[`.scratch/bebop-mvp/briefs/`](../.scratch/bebop-mvp/briefs/).
