---
type: task
status: open
---

# Finish triaging the fallow dead-code backlog to zero

## Question

`fallow dead-code` still reports 94 findings: 48 `unused-export`, 24 `unused-type`, 10
`unused-re-export-type`, 8 `unused-class-member`, 1 `unused-re-export`, 1 `unused-dep`, 1 `unused-devdep`, and
1 `unused-dependency-override`. `unused-files` is already at zero, and the prototype drivers, smoke scripts, and
spawned test fixture are modeled in `.fallowrc.json` (ADRs 0044–0045). This ticket closes the dead-code half of
the backlog.

For each finding, follow section 4 of the [Fallow adoption guide](https://docs.fallow.tools/adoption), "Match
the reason to the right mechanism", in order:

- real dead code — delete it;
- intentional API or public surface — `@public` / `@internal` / `@beta` visibility tags, or `publicPackages`
  when a whole package's exports are external;
- a false positive with a narrow reason — `entry`, `dynamicallyLoaded`, `ignoreExports`, or
  `// fallow-ignore-next-line <issue>`, never a broad rule change;
- deliberately kept but unused — `/** @expected-unused */`, which self-cleans the moment it is imported.

Work high-confidence first: the four dependency findings, then the mechanical `unused-type` and
`unused-re-export-type` findings, then the export and class-member triage where the delete-versus-tag decisions
live. Most of the 48 `unused-export` findings sit in `apps/bebop` and `apps/swordfish` CLI/service modules and
may be reachable surface the entry globs do not yet model — check `fallow list --entry-points` before tagging.

## Done when

`fallow dead-code` reports zero findings under the committed policy, every exception lives in config with a
comment or as a visibility tag (no accumulated inline suppressions), and the answer records what was deleted
versus modeled versus suppressed — the run that shows the clean state and the command that produced it.
