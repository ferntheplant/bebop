# No human-held seat credential survives a control release

The seat server's password is the write capability for that seat, so its lifetime is bound to the control lease rather than being ambient configuration. `sf status` never prints it; `sf attach` uses it without printing it; and every `handoff` rotates it if one was issued during that human-control episode.

Without rotation, one takeover would grant permanent shell-route access to that seat and every later lease would be advisory. Obtaining the ability to write to a seat therefore cannot happen without recording that it was taken.

## Consequences

Rotation restarts the seat's OpenCode server, because `OPENCODE_SERVER_PASSWORD` is read at process start — so Swordfish must re-attach the seat panes, re-establish its event subscription, and reconcile that restart like any other externally visible operation. Rotation is therefore conditional: if `sf attach` issued no credential during a control episode there is nothing to revoke, which keeps the common path — steering through the tmux pane, then handing off — free of a restart.
