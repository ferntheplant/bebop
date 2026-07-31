# No human-held seat credential survives a control release

The seat server's password is the write capability for that seat, so its lifetime is bound to the control lease rather than being ambient configuration. `sf status` never prints it; `sf takeover` may issue it; and every release of control — `sf handback`, the `/auto` confirmation flow, or role-aware plugin handback — rotates it if one was issued during that control episode.

Without rotation, one takeover would grant permanent shell-route access to that seat and every later lease would be advisory. Obtaining the ability to write to a seat therefore cannot happen without recording that it was taken.

## Consequences

Rotation restarts the seat's OpenCode server, because `OPENCODE_SERVER_PASSWORD` is read at process start. Sessions survive in the seat's `OPENCODE_DB`, but Swordfish must re-attach the seat panes and re-establish its event subscription, and must reconcile that restart like any other externally visible operation.

Rotation is conditional: if no credential was issued during a control episode there is nothing to revoke, which keeps the common path — steering through the tmux pane, then handing back — free of a restart.
