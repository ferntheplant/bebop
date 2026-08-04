# The cockpit

SSH into a bounty and you land somewhere useful: a tmux session Swordfish owns, showing the real cowboy terminals
rather than a reconstructed view of them. The principle behind it is that a background cowboy should be no less
inspectable than a local one — you can see the harness output, read the logs, and poke at the machine.

## What you can expect

- **The active cowboy first.** SSH lands on the active cowboy's full-screen OpenCode seat, with no default split
  competing for a laptop-sized terminal. During a deterministic stage with no active cowboy, it lands in an
  ordinary shell after printing one fresh `sf status` snapshot.
- **One named window per seat attempt.** Ein's durable seat and every fresh jet or faye attempt remain directly
  inspectable as real OpenCode TUIs rather than reconstructed transcripts. A newly active cowboy gets a window,
  but Swordfish never steals an attached client's focus.
- **Essential state in the tmux status line.** Stage, workflow controller, active cowboy, Bebop connection
  health, and attention are always visible. While Swordfish controls the active seat, the line says to run
  `sf takeover` from a shell. Detailed state and exact recovery commands live in bare `sf` or `sf status`.
- **Status on demand.** Swordfish creates no dedicated status window. `sf status --watch` remains available as a
  simple locally polled redraw when an operator chooses to dedicate a pane to it.
- **Free shell panes.** Ordinary shells for exploring the VM: dev servers, log files, processes, Git state.
  Nothing about supervision restricts these, and they are the intended way to find out what is really going on.
- **Logs without layout policy.** Swordfish captures each managed service's stdout and stderr in a stable named
  file. Status prints the exact `tail -F` command; the operator decides where that command runs.
- **Operator-shaped tmux.** Swordfish owns the session, managed seat windows, landing shell, and workflow status
  line. It never splits, joins, resizes, renumbers, or removes operator-created panes and windows.
- **Steering through one interface.** Cowboy tools, human slash commands, and authenticated `sf` commands invoke
  the same workflow actions. The plugin rejects a human model prompt while Swordfish controls the seat; an
  unexpected TUI shell, abort, revert, or unrevert is recorded as an intrusion and enters `needs_attention`.
- **Honest connection state.** A disconnected Swordfish is shown as disconnected, never as still working because
  its last event said so.

## Where it stands

**Designed.** No cockpit exists yet. The operator-shaped cockpit prototype confirmed that managed seat windows
can be added without changing focus or operator-created layout. A pinned OpenCode probe confirmed that shell,
abort, revert, and unrevert actions have distinct event signatures, so the cockpit does not use tmux input
disabling. The `sf` surface and MVP layout are settled.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **5** (SSH lands in the cockpit) and **6** (the cockpit shows
a healthy bebop connection).

## Decisions

- [The control lease blocks mixed model turns, not trusted cockpit input (ADR 0039)](../adr/0039-the-control-lease-blocks-mixed-model-turns-not-trusted-cockpit-input.md)
  — why the seat remains keyboard-enabled and unexpected seat mutations are detected instead.
- [The VM is the sandbox (ADR 0012)](../adr/0012-the-vm-is-the-sandbox.md) — why free shell panes are fine.
- [One controller drives one active cowboy (ADR 0037)](../adr/0037-one-controller-drives-one-active-cowboy.md)
- [Workflow actions have role-aware adapters (ADR 0038)](../adr/0038-workflow-actions-have-role-aware-adapters.md)

Herdr is not the MVP cockpit and cockpit v2 on the OpenCode web UI is out of scope for this effort; both are
recorded on [the map](../../.scratch/bebop-mvp/map.md).

## Still open

- [What does the cockpit tell an operator to do once `sf takeover` demands a credential?](../../.scratch/bebop-mvp/issues/23-cockpit-guidance-for-operator-authenticated-commands.md)
  — the status line points at a command that will prompt for a secret the VM cannot supply.
