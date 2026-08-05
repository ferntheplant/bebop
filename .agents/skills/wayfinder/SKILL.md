---
name: wayfinder
description: Plan a huge chunk of work — more than one agent session can hold — as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.
disable-model-invocation: true
---

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** on the repo's issue tracker, then works its **decision tickets** — questions whose resolution is a decision, not slices of a build to execute — one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

**Where a handoff lands is tracker-specific.** A resolution that makes a build-sized slice specifiable writes that slice up as its own artifact, owned by this map rather than by a new effort of its own — consult the tracker doc for what that artifact is called and where it goes.

## Refer by name

Every map and ticket has a **name** — its title, which on a file-based tracker is the ticket's `# ` heading, not its filename. In everything the human reads — narration, the map's Decisions-so-far — refer to it by that name, never by a bare id, number, slug, or path. A wall of `#42, #43, #44` is illegible, and `exe-dev-llm-integration.md` barely better; names read at a glance. The link doesn't vanish — a name wraps it — but it rides _inside_ the name, never stands in for it.

## The Map

The map is a single artifact on this repo's issue tracker, marked `wayfinder:map` — the canonical one. Its tickets are children of the map.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.

**Where the map, its child tickets, blocking, and frontier queries physically live is tracker-specific.** The issue tracker should have been provided to you — run `/setup-matt-pocock-skills` if not. Consult the tracker doc's "Wayfinding operations" section for how _this_ repo expresses them. If no tracker has been provided, default to the local-markdown tracker.

### On a file-based tracker

A local-markdown tracker has no issues, labels, assignees, comments, or native dependencies, so the operations below translate. Read the tracker doc for the paths; this is the translation.

| The skill says             | On files it is                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| the map issue              | `map.md` in the effort's directory — the `wayfinder:map` label is implied by being that file |
| a child issue              | one file per ticket in the effort's `issues/` directory, named by slug                       |
| the issue id               | that slug — but see [Refer by name](#refer-by-name)                                          |
| a `wayfinder:<type>` label | frontmatter `type:`                                                                          |
| assigning to claim         | frontmatter `status:` — `open` at creation, `claimed` saved **before** any work              |
| native blocking            | frontmatter `blocked-by: [<slug>, <slug>]` naming the tickets that must resolve first        |
| a frontier query           | scanning `issues/` for files that are open, unblocked, and unclaimed                         |
| a resolution comment       | an `## Answer` section appended to the ticket                                                |
| closing an issue           | frontmatter `status: resolved`                                                               |

Four consequences worth knowing before you start:

- **Slugs are chosen, not assigned.** Nothing needs to exist before something else can reference it, so charting has no create-then-wire second pass — write each ticket with its `blocked-by` already filled in. A slug also needs no knowledge of what exists, so parallel sessions never collide over an index; two people choosing the same slug have found a duplicate, which is information rather than a conflict.
- **A slug is an identity, not a location.** It stays with the item for its whole life — an inbox item promoted into an effort keeps its name, and `git mv` moves it.
- **The frontier isn't rendered for you.** A real tracker shows the human what's takeable in its own UI; a directory of files does not. Compensate by naming the takeable tickets when you finish charting, and again whenever a resolution unblocks something. With no numeric tiebreak, rank by critical path: the ticket blocking the most others, directly or transitively, goes first.
- **The tracker is in the repo, so it is in the diff.** Map and ticket edits are commits like any other. Keep them separate from code changes, and expect a resolution to show up in review.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — they are the map's open children, found by query. Listing them here would mean two places to keep in step, and the copy on the map would be the one that rots.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Each ticket is a **child** of the map; the tracker's id — an issue number, or a file's slug on a file-based tracker — is its identity. Its body is the question, sized to one 100K token agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Each ticket carries its type — one of `research`, `prototype`, `grilling`, `task` (see [Ticket Types](#ticket-types)) — as a `wayfinder:<type>` label, or as frontmatter `type:` where the tracker has no labels.

A session **claims** a ticket **first**, before any work, so concurrent sessions skip it: by assigning it to the dev driving the map, or by marking it claimed where the tracker has no assignees. An open, unclaimed ticket is takeable — so a claim that is never written down is a claim that didn't happen.

Blocking uses the tracker's **native** dependency relationship — essential because it renders the frontier _visually_ in the tracker's own UI, so the human sees what's takeable without opening the map. Only a tracker that lacks native blocking falls back to a body convention. A ticket is **unblocked** when every ticket blocking it is closed; the **frontier** is the open, unblocked, unclaimed children — the edge of the known.

The answer isn't part of the body — it's recorded on resolution (see [Work through the map](#work-through-the-map)). Assets created while resolving a ticket are linked from the ticket, not pasted in. On a file-based tracker that link is a repo-relative path, which stays correct in a way a URL does not.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked _with_ a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources like knowledge bases to surface a fact a decision waits on. Resolved by a `/research` **subagent**. Use when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code via the /prototype skill. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation via the /grilling and /domain-modeling skills, one question at a time. The default case.
- **Task** (HITL or AFK): Manual work that must happen before a _decision_ can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that _does_ rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination — mis-scoped in while charting, or exposed by a resolution — **close it** (a closed ticket is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked — a scope boundary isn't a step on it.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Run a `/grilling` and `/domain-modeling` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear, the whole journey small enough for one session — you don't need a map. Stop and ask the user how they'd like to proceed.
3. **Create the map** (marked `wayfinder:map`): Destination and Notes filled in, Decisions-so-far empty, the fog sketched into **Not yet specified**.
4. **Create the tickets you can specify now** as children of the map, then wire the blocking edges. On a tracker that assigns ids, wiring is a **second pass** — issues need ids before they can reference each other. On a file-based tracker you choose the slugs, so write each ticket with its blocking line already filled in. Either way, wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog — the **Not yet specified** section.
5. **Fire the research subagents.** For each `research` ticket you just created, spin up a `/research` subagent to resolve it in parallel, capturing its findings on a throwaway `research/<name>` branch with a context pointer from the ticket.
6. **Name the frontier.** Say which tickets are takeable now, by name. On a tracker with a UI this is a courtesy; on a file-based one it is the only place the human sees the frontier without scanning the directory themselves.
7. Stop — charting is one session's work; it hand-resolves nothing.

### Work through the map

User invokes with a map — a URL, a slug, or a path. A ticket is **optional** — without one, you pick the next decision, not the user.

1. Load the **map** — the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it** before any work, and persist the claim — on a file-based tracker that means writing and saving the file, not merely intending to.
3. Resolve it — **zoom as needed**: fetch the full body of any related or closed ticket on demand; invoke the skills the `## Notes` block names. If in doubt, use `/grilling` and `/domain-modeling`.
4. Record the resolution: post the answer as a **resolution comment**, **close** the ticket, and **append a context pointer** to the map's Decisions-so-far. All three, in that order — a closed ticket the map doesn't point at is a decision nobody will find again.
5. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals a ticket — this one or another — sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.
6. **Say what the resolution unblocked**, by name, so the next session — or the user running one in parallel — knows what became takeable.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently. On a file-based tracker that also means git: two sessions resolving two tickets touch different files, but both append to `map.md`, which is where the conflict will be.
