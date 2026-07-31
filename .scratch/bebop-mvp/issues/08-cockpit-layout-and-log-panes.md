# What does the cockpit look like, and where do log panes come from?

Type: prototype
Status: open
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
