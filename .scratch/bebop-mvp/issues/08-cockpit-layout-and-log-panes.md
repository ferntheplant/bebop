# What does the cockpit look like, and where do log panes come from?

Type: prototype
Status: resolved
Blocked by: 06, 07

## Question

The cockpit is a Swordfish-owned tmux with a status pane, locked seat panes, and free shell panes
([the cockpit](../../../docs/capabilities/03-the-cockpit.md)), with log panes generated from the services
declared in `.bebop/config.yml` — that last part provisional and unbuilt.

Build a fake cockpit against scripted output and settle:

- the default layout, and what a user sees the second they SSH in;
- how three seat panes, a status pane, N service log panes, and a free shell coexist on one screen, and what
  happens on a laptop-sized terminal;
- whether log panes are worth generating at all, or whether a service's logs belong behind a command;
- how a locked pane _communicates_ that it is locked, given that
  [the tmux lock is UX and not protection](../../../prototypes/tmux-input-lock/README.md) and that a user who
  types into it must be told to run `sf takeover` through some channel other than an HTTP response;
- what the status pane refreshes on, and whether it can be driven by the same event stream bebop clients use.

## Answer

The MVP cockpit starts smaller than the provisional design: SSH lands on one full-screen active cowboy seat,
not a dashboard grid. If no cowboy is active during a deterministic stage, attachment lands in an ordinary
shell after printing one fresh `sf status` snapshot. Swordfish creates one named window for ein's durable seat
and every fresh jet or faye attempt, but activating a new cowboy never moves an already attached client.
Inactive seat windows remain inspectable provenance.

Swordfish owns the tmux session, managed seat windows, the no-cowboy landing shell, and a narrow workflow status
line. The operator owns every pane and window they create. Swordfish never splits, joins, resizes, renumbers, or
removes that operator layout; it may recreate a missing active-seat window during reconciliation. This avoids a
desktop layout that collapses on a laptop and lets each operator spend their screen on the seat, shell, or logs
they currently need.

There is no generated status window. The tmux status line carries only stage, workflow controller, active
cowboy, Bebop connection health, and a conspicuous attention indicator. While Swordfish controls the active
seat it also says to run `sf takeover` in a shell, because an OpenCode plugin rejection reaches the TUI as an
opaque error. Bare `sf` and `sf status` render the detailed snapshot and exact recovery commands on demand.
`sf status --watch` remains an optional convenience for an operator-created pane and uses simple local polling;
the cockpit does not depend on Bebop's SSE stream to report that Bebop is disconnected.

Repository-declared services do not generate panes or windows. Swordfish captures each managed service's
stdout and stderr in a stable named file, and status prints the exact `tail -F` command. Repository configuration
describes processes and previews, not terminal layout.

### Keyboard input and the control lease

Seat panes remain keyboard-enabled while Swordfish controls them. The plugin rejects ordinary prompt and
slash-command routes before a model provider call, but the cockpit does not use tmux `select-pane -d`. Free
shell panes already let a trusted operator mutate the same worktree, any operator can clear the tmux flag, and
the lock therefore did not enforce authority that the cockpit actually promised.

The no-lock decision is conditional on detecting seat-local mutations the plugin cannot reject. The pinned
[OpenCode seat-mutation event prototype](../../../prototypes/opencode-seat-mutation-events/README.md) confirmed
distinct event signatures for all known keyboard-driven bypasses: shell commands produce assistant tool parts,
abort produces `MessageAbortedError`, revert adds a session revert marker, and unrevert removes it. Swordfish
knows which mutations it originated; any other one records intrusion provenance and suspends the current stage
as `needs_attention`. Detection does not roll back an already applied side effect.

The [operator-shaped cockpit prototype](../../../prototypes/cockpit/README.md) confirmed that the initial seat is
one pane and that adding a fresh managed seat preserves both client focus and operator-created panes and
windows. The input decision supersedes the tmux layer in
[The control lease is enforced in four independent layers (ADR 0009)](../../../docs/adr/0009-the-control-lease-is-enforced-in-four-layers.md);
the replacement is [The control lease blocks mixed model turns, not trusted cockpit input (ADR 0039)](../../../docs/adr/0039-the-control-lease-blocks-mixed-model-turns-not-trusted-cockpit-input.md).
