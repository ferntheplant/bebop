---
status: open
---

# Brief: finish triaging the fallow dead-code backlog to zero

## Scope

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

## Comments

Opened 2026-08-05 with 94 findings (49 exports, 34 types, 8 class members, 2 deps, 1 override).

Closed 2026-08-05 — `vp exec fallow dead-code` now reports zero. Disposition of the 94:

- **Unexported (module-private) — 64.** The identifier is used within its own file; the `export` keyword was
  the only dead thing. Includes every `Context.Service` shape type, row decoders, config schemas/values, error
  classes, stage/status consts, cursor helpers, and the local-system `describeError`.
- **Deleted — 19.** Genuinely dead, no in-file or cross-file consumer: `ApiServices`, `VmMapping`,
  `BountyServiceRequirements`, `BountyServiceFailure`, `ProjectionServiceRequirements`,
  `ProjectionServiceFailure`, `SwordfishRuntimeLayer`, the `boolean` row decoder, and the `BebopHttpApi` and
  both `@bebop/workflow` re-export barrels (ten type re-exports).
- **Config-modeled — 10.** The seven `_tag` fields on hand-rolled `Error` subclasses in contracts and
  `RowDecodeError`, held by one `usedClassMembers` rule scoped to `extends: "Error"`. Deleting them was tried
  first and reverted: TypeScript is structurally typed, so with no other members declared,
  `InvalidSfControlRequestError`, `InvalidSfControlResponseError`, and `UnexpectedSfControlResponseError`
  became mutually assignable and a bare `new Error()` satisfied all three. The field is a nominal brand read
  by the type checker, not the program — fallow is right that no code reads it, and wrong that it is dead.
  Runtime discrimination stays `instanceof` (the one `_tag` read in `protocol-decode.ts` became an
  `instanceof` to match the rest of the codebase). Also here: the `@effect/platform-node-shared` override
  (resolves in `bun.lock`; fallow's check assumes a pnpm lockfile this repo does not have, and the rule is
  scoped to `source: "package.json"`), and the removal of `@effect/platform-bun` from testkit (the apps and
  prototypes declare it themselves) and `@opencode-ai/sdk` from lease-guard (never imported; also dropped the
  now-unused catalog entry and updated the README pin line).
- **Suppressed — 1.** `AuthorityIdentityError.message` getter, a single narrow
  `// fallow-ignore-next-line unused-class-member` with a comment: the operator-facing message is read
  through the base `Error` contract and fallow cannot attribute those reads. The comment cites
  `apps/swordfish/test/component/persistence.test.ts`, which asserts the rendered text and so fails if the
  getter stops being load-bearing.
