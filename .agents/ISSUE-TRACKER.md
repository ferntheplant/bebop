# Issue tracker: Local Markdown

Issues and briefs for this repo live as markdown files in `.scratch/`.

`.scratch/` is **committed**, not ignored. It is the canonical tracker for this repo, not scratch space.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The brief — what one PR is meant to build, which you may know as a PRD — is `.scratch/<feature-slug>/brief.md`. It is deliberately not called a spec: [`CONTEXT.md`](../CONTEXT.md) reserves that word for a bounty's effective spec
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

A brief stays with its effort once shipped. It is history, not authority — anything in one still worth defending months later belongs in an [ADR](../docs/adr/).

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## Active efforts

- [Bebop MVP](../.scratch/bebop-mvp/map.md) — the route from the current control plane to a merged bounty.
- [Fallow cleanup](../.scratch/fallow-cleanup/map.md) — zero Fallow findings under a committed policy, then
  `fallow audit` as a PR gate.

## Completed efforts

- [The orthogonal control model](../.scratch/workflow-control-model/brief.md) — ADRs 0036–0043 shipped in the
  orthogonal model and constraint-ledger slices.
