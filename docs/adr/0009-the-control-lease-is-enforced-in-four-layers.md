# The control lease is enforced in four independent layers

Only one actor — `human` or `swordfish` — may submit prompts to a seat, and that is enforced four times over: tmux disables input to leased seat panes (UX); the bebop plugin rejects prompt submission on a leased seat (authoritative for model turns); Swordfish spawns each seat's OpenCode server with a random per-boot `OPENCODE_SERVER_PASSWORD` and a private `OPENCODE_DB` (transport); and Swordfish records any message or tool execution it did not originate as an intrusion (detection).

The design began with two layers and the [lease-guard prototype](../../prototypes/lease-guard/README.md) proved that insufficient against pinned OpenCode 1.18.5. Throwing from `chat.message` or `command.execute.before` does abort a turn before the model provider is contacted — but `POST /session/:id/shell` executes in a leased seat without invoking any plugin hook, and `opencode serve --pure` skips project-local plugins entirely, so a second instance in the same directory drove a leased seat with no guard loaded.

## Consequences

The layers compose and fail independently, which is the point: the plugin is authoritative for model turns, the transport controls close the routes and instances the plugin cannot see, and detection is route-agnostic so it still catches an unhooked route added by a future OpenCode version.

Bypass remains possible for a determined operator with a shell in the VM. That is accepted — the goal is that it cannot happen by accident.

Two testing constraints follow. Any test of the guard must assert that the model endpoint received **zero** requests, not merely that an error was returned. And a hook's thrown message does not reach the HTTP caller — the synchronous route returns an opaque server error, the asynchronous route returns `204` — so "run the takeover command" must be delivered through the event stream, the seat TUI, or the status pane, never the response body.
