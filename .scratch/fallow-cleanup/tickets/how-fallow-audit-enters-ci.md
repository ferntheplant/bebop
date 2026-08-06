---
type: grilling
status: open
---

# How does `fallow audit` enter CI?

## Question

The [adoption guide](https://docs.fallow.tools/adoption) splits the work into **repo clean** (full-repo
analysis, fix the backlog) and **PR clean** (`fallow audit` as a changed-files gate), and is explicit that they
happen in that order. Dead-code repo-clean has landed — `fallow dead-code` reports zero under the committed
policy — which clears the guide's stage 1 bar for shipping the gate:

- the policy is encoded in `.fallowrc.json`, not accumulated in scattered suppressions;
- unresolved imports and unlisted dependencies are clear;
- blatant dead code (unused files, unused dependencies) is gone.

Only the last stage-1 item is missing: `fallow audit` wired into CI and passing for new changes. Duplication and
health are stage 2 ("ideal state") and do not block it.

Settle:

- **Which rollout shape.** The guide names three, and they are not mutually exclusive:
  - **A, warn-everywhere.** CI never blocks; fixes land under social pressure. The guide's own warning is that
    warn-only gates become warning-forever gates. This repo currently has exactly one rule at `warn`
    (`unused-dependencies`), so adopting A means deciding what else drops to `warn` and what the promotion
    trigger is.
  - **B, error plus committed baselines.** CI blocks on new findings; pre-existing debt is baselined into
    `fallow-baselines/` and regenerated on a schedule rather than per merge. The question is whether this repo
    has debt worth baselining at all — dead-code is at zero, so a dead-code baseline would be an empty ledger,
    while health has a real backlog (`changesFor` at cyclomatic 113 / cognitive 155).
  - **C, local agent gate.** A `PreToolUse` hook intercepting `git commit`/`git push`, blocking only on
    `verdict: "fail"` and handing the audit JSON back to the agent to fix. The guide is clear this pairs with A
    or B rather than replacing them, since it only covers agent-driven pushes. Given how much of this repo is
    written that way, C may be the highest-leverage half — but it is a `.claude/settings.json` change with
    failure modes (fail-open on config errors, first commit in an empty repo) that want thinking through.
- **Whether the gate covers all three analyses on day one,** or dead-code only until duplication and health
  reach their own clean state. A gate that fails on health findings the repo has not yet triaged would block
  every PR touching `packages/workflow/src/core.ts`.
- **Where it hangs in `.github/workflows/ci.yml`.** `vp run ready` is one task with five dependents, and a
  failing audit should read as a distinct signal rather than a mystery inside `ready`. The workflow already has
  `fetch-depth: 0`, so the base ref an audit diffs against is available.
- **What happens to `unused-dependencies: "warn"`.** It is the one rule already softened; whichever shape wins
  should either promote it or record why it stays.

The decision this settles is not "should we gate" — the map's destination already says we do. It is which of
the three shapes this repo runs, and how much of the analysis surface the gate carries before stage 2 lands.

## Notes

Health and duplication each have their own fog on the map and are not in scope here beyond the question of
whether the gate waits for them.
