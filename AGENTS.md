# Bebop

Bebop moves a trusted local coding-agent workflow onto remote computers. Read
[`ABSTRACT.md`](./ABSTRACT.md) first if you don't know what that means.

## Where things live

| If you need                              | Read                                                               |
| ---------------------------------------- | ------------------------------------------------------------------ |
| What Bebop is and what "done" looks like | [`ABSTRACT.md`](./ABSTRACT.md)                                     |
| What the system does for its user        | [`docs/capabilities/`](./docs/capabilities/)                       |
| What a word means                        | [`CONTEXT.md`](./CONTEXT.md)                                       |
| Why something is the way it is           | [`docs/adr/`](./docs/adr/)                                         |
| Why something that looks broken isn't    | [`docs/gotchas.md`](./docs/gotchas.md)                             |
| What is still undecided                  | [`.scratch/bebop-mvp/map.md`](./.scratch/bebop-mvp/map.md)         |
| What a PR is meant to build              | `.scratch/<feature>/brief.md`, alongside that effort's tickets     |
| How to run and test things               | [`README.md`](./README.md), [`docs/testing.md`](./docs/testing.md) |
| How the issue tracker works              | [`.agents/ISSUE-TRACKER.md`](./.agents/ISSUE-TRACKER.md)           |

New writing goes to one of those homes from the start. Nothing lives in two of them: a capability file says what
a user can expect and links the decision behind it rather than restating it.

## Vocabulary

Two glossaries are binding, and using their words exactly is the point of having them.

- **Domain language** — [`CONTEXT.md`](./CONTEXT.md). A bounty is not a job. A seat is not a session. Merging is
  catching the bounty. If you need a term that isn't there and the conversation settles it, add it.
- **Design language** — the `codebase-design` skill. Say **module**, **interface**, **implementation**,
  **adapter**, **seam**, **depth**. Not "component", "service", "API" (for a module's interface), or
  **"boundary"** — that word is retired here; say seam or interface.

Design deep modules: a lot of behaviour behind a small interface, placed at a clean seam, tested through that
interface. One adapter means a hypothetical seam; two adapters means a real one.

## Architectural rules

- `packages/contracts` defines schemas; transport implementations consume them.
- Every network and local-socket payload is decoded where it arrives.
- Domain failures are typed values; defects remain crashes handled by process supervision.
- State transitions are pure and tested separately from persistence and I/O.
- State derivable from the event stream is derived on read, never stored — a compact status written to a column
  is a second copy that the first missed update leaves permanently wrong.
- Postgres is authoritative for bebop state; SQLite is authoritative for Swordfish state.
- Bebop and Swordfish write durable intent before performing externally visible side effects.
- At-least-once messages carry stable IDs or sequence numbers and are safe to replay.
- Time, IDs, process execution, and external clients are Effect services so tests can replace them.
- OpenCode is integrated directly. Do not create a generic agent-harness abstraction.
- exe.dev and GitHub sit behind app-local services for testing, not shared multi-provider abstractions.
- Apps may depend on packages; one app must not import source from another app. Code moves into a package when a
  second app needs it — never a `utils`.
- Logs are structured and include `bounty_id`, `vm_id`, `seat`, `stage`, `candidate_sha`, and correlation IDs
  when available.

Most of these have an ADR behind them. If a rule seems wrong, look for its ADR before working around it.

Cite an ADR by **name and number**, with the name first: `[Readiness is a claim (ADR 0003)](./docs/adr/0003-readiness-is-a-claim-not-authority.md)`. The name is what reads at a glance; the number is what a file search finds. A bare `ADR 0003` is not a citation.

## Definition of done

A change is done when:

- its production path is reachable through a real entrypoint;
- schemas validate everything crossing an external seam;
- success, expected failure, restart, and cancellation behaviour are tested;
- resources are cleaned up after success **and** failure;
- logs identify the bounty and the operation;
- the acceptance criteria in `ABSTRACT.md` §8 are demonstrably closer to passing;
- `vp run ready` passes from a clean checkout;
- documentation is updated where implementation invalidated an assumption — a new decision means a new ADR, a
  new term means a `CONTEXT.md` entry.

Tests must not call a paid model by default. OpenCode integration tests use a local fake model endpoint with
scripted streaming and tool-call responses; provider smoke tests are explicit and separately gated.

All commits follow Conventional Commits.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
