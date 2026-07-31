# Milestones

Historical index. Code comments, prototype write-ups, and `SYSTEM.md` refer to milestones by number, and this
file is what those references resolve against.

Milestones are **not** the plan any more. The route from here is charted on
[`.scratch/bebop-mvp/map.md`](../../.scratch/bebop-mvp/map.md): open questions are tickets, areas too dim to
ticket are fog, and each PR-sized slice of build gets a spec when its fog clears. Nothing new should be
described as a milestone.

| #   | Covered                                                                        | Status                         |
| --- | ------------------------------------------------------------------------------ | ------------------------------ |
| 0   | Build-critical assumptions, proved by the four [prototypes](../../prototypes/) | Complete, validated 2026-07-26 |
| 1   | Monorepo, tooling, CI, entrypoints                                             | Complete, validated 2026-07-26 |
| 2   | Contracts, protocols, and the pure workflow core                               | Complete, validated 2026-07-26 |
| 3   | The local bebop server: API, worker, Postgres, thin CLI                        | Complete, validated 2026-07-29 |
| 4   | Swordfish core over SQLite, and the `sf` control client                        | Complete, validated 2026-07-29 |
| 5   | Bebop–Swordfish end-to-end protocol across a breakable network                 | Not started                    |
| 6   | Repository configuration, clean-room worktrees, and hooks                      | Not started                    |
| 7   | OpenCode and plugin integration                                                | Not started                    |
| 8   | Cockpit and human control                                                      | Not started                    |
| 9   | exe.dev provisioning and authentication                                        | Not started                    |
| 10  | GitHub, gates, QA, and evidence                                                | Not started                    |
| 11  | Recovery, operations, and release qualification                                | Not started                    |

What each completed milestone decided is recorded in [`docs/adr/`](../adr/), not here. What the remaining ones
still have to decide is on the map.
