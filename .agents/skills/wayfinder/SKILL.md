---
name: wayfinder
description: Chart and walk a project's map — the decision tickets standing between a loose idea and a clear route, resolved one at a time until no fog is left. Use when work is too big for one session and the way to the destination isn't visible yet.
disable-model-invocation: true
---

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination.

This skill is the **method**. [`.agents/ISSUE-TRACKER.md`](../../ISSUE-TRACKER.md) is the **mechanism** — where files live, what frontmatter they carry, how triage and closing work. Read it first; everything below assumes its vocabulary and never restates its rules.

## What a map is for

**A map is a decisioning instrument.** It exists to track the fog between here and the destination, and to point at the decision tickets that clear it. That is its whole job.

This is the distinction that keeps the two artifacts from blurring:

|             | Holds                                                          | Done when                  |
| ----------- | -------------------------------------------------------------- | -------------------------- |
| **Project** | Every ticket for a destination — decisions **and** builds      | The destination is reached |
| **Map**     | The route: destination, fog, and the decisions that cleared it | No fog is left             |

**A project outlives its map.** The map closes when the way is clear — when everything remaining is specifiable. What remains at that point is `build` tickets, and those are the project's, not the map's. A map with no fog and six build tickets under it is a finished map on a live project, which is the normal end state, not a problem.

So:

- **The map charts decision tickets only** — `grilling`, `prototype`, `research`, `task`. Those are its children.
- **Build tickets sit in the same project directory and are not charted.** No map section lists them, and resolving one is not a step on the route. They are the output of wayfinding, not part of it.
- **Decisions so far records decisions**, never builds. A merged PR is not a step on the route; it is the road being paved after the route was found.

There is no "this map carries execution" override. A map that wants one has confused itself with its project — write the build tickets and let the map be done.

## Plan, don't do

Each ticket the map charts resolves a decision. The map is done when nothing is left to decide before someone goes and does the thing.

**The pull to just do the work is the signal you've reached the edge of the map.** Don't push through it — that is the moment to write a `build` ticket and stop. A resolution that makes a PR-sized slice specifiable writes that slice up as a `build` ticket in the project's `tickets/` directory, and the map's job for that area is over.

## Refer by name

Every map and ticket has a **name** — its `# ` heading, not its filename. In everything the human reads — narration, Decisions-so-far — refer to it by that name. `exe-dev-llm-integration.md` is illegible where "Can the exe.dev LLM integration serve ein and jet?" reads at a glance. The link doesn't vanish; it rides _inside_ the name rather than standing in for it.

## The map body

The whole map at low resolution, loaded once per session. **Open tickets are not listed** — they are found by scanning the project's `tickets/` directory. Listing them here would mean two places to keep in step, and the copy on the map would be the one that rots.

```markdown
# <Project name>

Label: `wayfinder:map`

## Destination

<what reaching the end looks like. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this project>

## Decisions so far

<!-- one line per decision, only while it has no durable home -->

## Not yet specified

<!-- in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- work ruled beyond the destination; never graduates -->
```

**Decisions so far is not an archive.** The tracker deletes a ticket once its outcome lands in an ADR, a capability, or a gotcha, and the map then cites that artifact by name and number — or says nothing at all, because `docs/adr/` is already the index of what was decided. An entry earns its line only while the decision has nowhere durable to live yet.

## Ticket bodies

A decision ticket's body is the question, sized to one 100K-token agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Assets created while resolving one are **linked** from the ticket, not pasted in — a repo-relative path, which stays correct in a way a URL does not. The answer isn't written up front; it is appended on close.

Frontmatter, statuses, blocking, and the deletion rule are all in [the tracker doc](../../ISSUE-TRACKER.md#file-formats). Two consequences of a file-based tracker are worth knowing before you start:

- **Slugs are chosen, not assigned.** Nothing needs to exist before something else can reference it, so charting has no create-then-wire second pass — write each ticket with its `blocked-by` already filled in.
- **The frontier is rendered, not stored.** `vp run next` derives Build, Decide, and Triage from `.scratch/`,
  so nobody hand-writes "the next work is". It reads status and blocking, not reasons, so still name the
  takeable tickets when you finish charting, and again whenever a resolution unblocks something.

## How to work each decision type

Every decision ticket is either **HITL** — worked _with_ a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; **the agent never stands in for the human's side of it.** A grilling agent that answers its own questions has broken this, and the resolution it produces is worthless.

- **`research`** (AFK) — Reading documentation, third-party APIs, or other resources to surface a fact a decision waits on. Resolved by a `/research` **subagent**. Use when the knowledge lives outside the working directory.
- **`prototype`** (HITL) — Raise the fidelity of the discussion with a cheap, rough artifact to react to: an outline, a stub, or UI/logic code via `/prototype`. Link the prototype as an asset. Use when "how should it look" or "how should it behave" is the real question.
- **`grilling`** (HITL) — Conversation via `/grilling` and `/domain-modeling`. The default case.
- **`task`** (either) — Manual work that must happen before a decision can be made: signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. The agent drives it alone where it can; otherwise it hands the human a precise checklist. Its answer records what was done plus any facts later tickets depend on — credential locations, new URLs, row counts.

`build` is the fifth type and is not on this list, because a build ticket is not worked through the map. See [the tracker doc](../../ISSUE-TRACKER.md#tickets-cover-both-deciding-and-building).

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — decisions you can tell are coming but can't pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever is now specifiable into fresh tickets, one at a time, until the way is clear.

**Not yet specified** is where that dim view is written down. Everything in it is in scope, just not sharp enough to ticket. It doubles as a signpost for whoever reads where the project is headed.

**Fog or ticket?** The test is whether you can state the question precisely _now_ — not whether you can answer it now.

- **Ticket** when the question is already sharp, even if it's blocked and you can't act on it yet.
- **Not yet specified** when you can't phrase it that sharply. Don't pre-slice fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none.

**Not yet specified** excludes what's decided, what's already a live ticket, and what's out of scope.

## Out of scope

Fog gathers only _toward_ the destination. The destination fixes the scope, so work beyond it isn't fog — it gets its own **Out of scope** section. Scope, not sharpness, lands it there.

Out-of-scope work never graduates. It returns only if the destination is redrawn, and then as a fresh project, not a resumption.

When a ticket that already exists turns out to sit past the destination — mis-scoped while charting, or exposed by a resolution — **delete it** and leave one line in **Out of scope**: the gist, plus why it's out. It stays out of **Decisions so far**, which records the route actually walked; a scope boundary isn't a step on it.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — research tickets excepted, since subagents run them in parallel.

### Chart the map

The user invokes with a loose idea.

1. **Name the destination.** `/grilling` and `/domain-modeling` to pin down what this project is finding its way to. The destination fixes the scope, so it settles first.
2. **Map the frontier.** Grill again, **breadth-first**: fan out across the whole space rather than deep on one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way is already clear, the journey small enough for one session — there is no map to draw. Stop and say so; what the user has is a build ticket, or a few.
3. **Write the map**: Destination and Notes filled in, Decisions-so-far empty, the fog sketched into **Not yet specified**.
4. **Write the tickets you can specify now**, each with its `blocked-by` already filled in. That sorts them into the frontier and the blocked in one pass; everything you can't specify stays in the fog.
5. **Fire the research subagents.** For each `research` ticket, spin up a `/research` subagent to resolve it in parallel, capturing findings on a throwaway `research/<name>` branch with a pointer from the ticket.
6. **Name the frontier** — which tickets are takeable now, by name. `vp run next` renders the list; the
   narration says which one is being taken, and why.
7. Stop. Charting is one session's work and resolves nothing by hand.

### Work through the map

The user invokes with a project — a slug or a path. A ticket is **optional**; without one, you pick the next decision, not the user.

1. Load the **map** — the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it; otherwise take the first frontier ticket, ranked by critical path. **Claim it before any work** — write and save the file, don't merely intend to.
3. Resolve it, **zooming as needed**: fetch the body of any related ticket on demand, and invoke the skills the `## Notes` block names. If in doubt, `/grilling` and `/domain-modeling`.
4. **Close it** per [the tracker doc](../../ISSUE-TRACKER.md#closing-a-ticket) — including writing the durable artifact and deleting the ticket. A decision that exists only as a closed ticket is one nobody will find again.
5. **Graduate the fog** the answer made specifiable into new tickets, clearing each graduated patch from **Not yet specified**. If the answer makes a PR-sized slice specifiable, that's a `build` ticket and the map is done with that area. If it reveals a ticket sits past the destination, rule it out of scope. If it invalidates other tickets, update or delete them.
6. **Say what the resolution unblocked**, by name, so the next session knows what became takeable.

Expect concurrent sessions: the user may run unblocked tickets in parallel. Two sessions closing two tickets touch different files, but both may append to `map.md` — that is where the conflict will be.
