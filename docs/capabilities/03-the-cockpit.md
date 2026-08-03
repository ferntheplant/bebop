# The cockpit

SSH into a bounty and you land somewhere useful: a tmux session Swordfish owns, showing the real agent terminals
rather than a reconstructed view of them. The principle behind it is that a background agent should be no less
inspectable than a local one — you can see the harness output, read the logs, and poke at the machine.

## What you can expect

- **A status pane** Swordfish renders: bounty and repository identity, bebop connection freshness, workflow
  stage, active seat, lease owner, branch and candidate SHA, gate statuses, constraint consumption, preview URLs,
  recent events, and takeover or handback progress when control is moving.
- **Seat panes** — the actual OpenCode TUIs for ein, jet, and faye, visible whenever those seats exist. Not a
  chat transcript reassembled from an API.
- **Free shell panes.** Ordinary shells for exploring the VM: dev servers, log files, processes, Git state.
  Nothing about supervision restricts these, and they are the intended way to find out what is really going on.
- **Service log panes** generated from the `services` list a repository declares.
- **Steering through `sf`**, not through typing into a pane you happen to be looking at. Seat panes whose lease
  Swordfish holds have keyboard input disabled.
- **Honest connection state.** A disconnected Swordfish is shown as disconnected, never as still working because
  its last event said so.

## Where it stands

**Designed.** No cockpit exists yet. A prototype established that tmux's `select-pane -d` disables input while
the pane keeps rendering, and — importantly — that any pane in the session can clear it, so the tmux layer is UX
rather than protection. The layout and the `sf` surface are both open questions.

## Acceptance criteria

Owns [`ABSTRACT.md`](../../ABSTRACT.md) §8 criteria **5** (SSH lands in the cockpit) and **6** (the cockpit shows
a healthy bebop connection).

## Decisions

- [The four-layer control lease (ADR 0009)](../adr/0009-the-control-lease-is-enforced-in-four-layers.md) — why
  the tmux input lock is one layer of four and cannot be the only one.
- [The VM is the sandbox (ADR 0012)](../adr/0012-the-vm-is-the-sandbox.md) — why free shell panes are fine.

Herdr is not the MVP cockpit and cockpit v2 on the OpenCode web UI is out of scope for this effort; both are
recorded on [the map](../../.scratch/bebop-mvp/map.md).

## Still open

- [What does the cockpit look like, and where do log panes come from?](../../.scratch/bebop-mvp/issues/08-cockpit-layout-and-log-panes.md)
- [What is the `sf` command surface, in use?](../../.scratch/bebop-mvp/issues/07-the-sf-command-surface.md)
