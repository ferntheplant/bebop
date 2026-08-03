# Repository configuration

The one capability you author. A target repository declares how it is set up, validated, and QA'd in a `.bebop/`
directory that travels with the code — Bebop does not guess how to build your project, and it does not want to.
This is the whole configuration surface of the product.

## What you can expect

- **Plain executables, any language.** A hook is a file Swordfish runs; there is no plugin API to learn and no
  framework to adopt. Exit zero passes, nonzero fails.
- **Hooks for each stage the system needs one.** Setup hooks prepare an environment — the full dev environment
  for ein's worktree, a dependencies-only clean room for verification, and a QA environment with services and
  seed data. Runtime hooks validate a candidate, start and reset QA services, and collect extra artifacts.
- **A declarative `config.yml`** for services, ports, health checks, preview labels, seed data, timeouts,
  environment requirements, and additional privileged globs.
- **Structured results are optional.** A hook may write JSON findings and drop artifacts in a directory Bebop
  provides, but its exit code is what counts. You never have to produce structured output to be useful.
- **Hooks run inside the sandbox and get no bebop credentials.** They may produce results and local artifacts;
  they never publish anything externally themselves.
- **Your configuration protects itself.** `.bebop/**` is permanently privileged: a candidate that edits it stops
  the pipeline for your inspection, and the glob list is read from the base revision so it cannot be weakened by
  the change being evaluated. Approval is pinned to that exact SHA, and no autonomous path can grant it.

## The contract

Everything below is what a repository codes against. Which hook runs when belongs to the stage that runs it:
[provisioning](./02-provisioning-and-attachment.md), [local validation](./08-local-validation.md), and
[QA](./10-qa.md).

```text
.bebop/
  config.yml          # services, ports, preview labels, timeouts,
                      # env requirements, privilegedPaths (extra globs)
  setup/
    primary           # full dev env for ein's worktree
    verification      # deps-only clean-room setup
    qa                # QA env: services + seed data
  hooks/
    validate          # authoritative validators
    qa-start          # boot QA services, wait healthy
    qa-reset          # reset disposable state
    collect-evidence  # emit extra artifact paths
```

Every `setup/` and `hooks/` entry is a plain executable in any language:

```text
exit 0 = pass, nonzero = fail
stdin:  nothing
env:    BEBOP_SHA, BEBOP_STAGE, BEBOP_WORKTREE,
        BEBOP_PORT_*, BEBOP_RESULT_FILE, BEBOP_ARTIFACT_DIR
optional: write JSON findings to $BEBOP_RESULT_FILE
artifacts: copy into $BEBOP_ARTIFACT_DIR
```

Exit code is authoritative; stdout and stderr are captured as logs.

`config.yml` declares dependency and environment requirements, services with their ports, health checks, and
preview labels, seed data, timeouts, and additional privileged globs. Swordfish captures managed service output
in stable files and reports exact follow commands without making repository configuration control tmux layout.

## Where it stands

**Designed.** The layout, the hook contract, the environment variables, and the trust rule are all settled and
written down, but nothing has run against a real repository. The shape of the failure modes — a hook that hangs,
a service that never becomes healthy, a port that collides — is expected to decide how much of the contract has
to change.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criterion **19** (a change under `.bebop/` or a configured privileged
glob enters `needs_attention`, and `approve-config` for that exact SHA resumes the pipeline).

## Decisions

- [`.bebop/**` is permanently privileged (ADR 0011)](../adr/0011-the-bebop-directory-is-permanently-privileged.md)
  — the candidate cannot be allowed to weaken the rules that evaluate it, and this deliberately makes legitimate
  tooling work slower.
- [Verification runs in a clean-room worktree (ADR 0015)](../adr/0015-verification-runs-in-a-clean-room-worktree.md)
  — what a setup hook is preparing, and why it cannot be ein's desk.

## Still open

- **Repository configuration in practice** — fog on [the map](../../.scratch/bebop-mvp/map.md): the contract is
  designed but has never met a real repository.
