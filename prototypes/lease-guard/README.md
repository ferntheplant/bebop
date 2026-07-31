# Prototype: OpenCode plugin control-lease guard

**Status:** Complete — assumption **partially confirmed**

**Date:** 2026-07-26

**Pinned OpenCode version:** 1.18.5 (`@opencode-ai/plugin@1.18.5`, `@opencode-ai/sdk@1.18.5`)

**Assumption under test:** [`docs/design/SYSTEM.md`](../../docs/design/SYSTEM.md) §11.5 — "the bebop plugin rejects prompt submission on a
leased seat regardless of how the prompt arrived — including a user who opens a second OpenCode client from a
shell pane."

**Milestone:** Milestone 0, "Prove the OpenCode plugin API can reject prompt submission for a leased seat."

## Verdict

The **authoritative lease guard is implementable** for every route that can start a model turn. It is **not**
complete on its own: `POST /session/:id/shell` executes in a leased seat without invoking any plugin hook, and
a second OpenCode instance started with `--pure` bypasses the plugin entirely.

Both gaps close with two environment variables Swordfish sets when it spawns OpenCode
(`OPENCODE_SERVER_PASSWORD` and a private `OPENCODE_DB`), so §11.5's third layer costs configuration rather
than architecture, and the credential doubles as a takeover token. See findings 4 through 6.

| Submission route                      | Lease: `human`       | Lease: `swordfish`       | Guarded |
| ------------------------------------- | -------------------- | ------------------------ | ------- |
| `POST /session/:id/message` (sync)    | 200, 1 model call    | **500, 0 model calls**   | yes     |
| `POST /session/:id/prompt_async`      | 204, 1 model call    | **204, 0 model calls**   | yes     |
| `POST /session/:id/command` (`/auto`) | 200, 1 model call    | **500, 0 model calls**   | yes     |
| `POST /session/:id/shell`             | 200, side effect ran | **200, side effect ran** | **no**  |

The load-bearing measurement is `modelCalls`, not the HTTP status: the fake model endpoint counts every inbound
request, so `modelCalls=0` proves the turn was aborted before the provider was contacted rather than merely
reported as failed afterwards.

## Findings

### 1. Throwing from a hook aborts the turn (confirmed)

`chat.message` is typed `(input, output) => Promise<void>` — unlike `permission.ask`, it has no `output.status`
deny channel. The only available mechanism is throwing, and OpenCode 1.18.5 treats a throw as an abort: the
turn stops, the provider is never called, and a `session.error` event is emitted.

`command.execute.before` behaves the same way and fires _before_ `chat.message` for slash-command submissions,
so `/auto` and every other command is covered twice.

### 2. `POST /session/:id/shell` bypasses the plugin entirely (new — not in the design)

With the lease held by Swordfish, the shell route returned 200, created an assistant message with a `tool`
part, and **executed the command** (verified by a sentinel file appearing on disk). None of `chat.message`,
`tool.execute.before`, or `command.execute.before` fired.

This is a real hole in `SYSTEM.md` §11.5's "regardless of how the prompt arrived." A user with HTTP access to the
OpenCode server — exactly what a cockpit shell pane provides — can run arbitrary commands attributed to a
leased seat and mutate ein's worktree without the supervisor observing it.

Note the tmux input lock (§16.2) does not mitigate this: the bypass is an HTTP call, not a keystroke.

### 3. The denial reason does not survive to the caller

The synchronous route returns an opaque `{"name":"UnknownError","data":{"message":"Unexpected server error.
Check server logs for details.","ref":"err_..."}}` — the thrown message is stripped. The async route returns
`204 No Content` and reports nothing at all; the denial surfaces only as a `session.error` event.

`SYSTEM.md` §11.5 says the plugin "tells the user to run the takeover command." That cannot be delivered through the
HTTP response. It has to come from the event stream, the seat's TUI, or the Swordfish status pane.

### 4. Session storage is shared per project, and `--pure` skips plugins

A second OpenCode server started in the same project directory sees the first server's sessions, because
session state lives on disk per project rather than in the server process. Started as
`opencode serve --pure` — no plugins, no password — it drove a leased seat completely:

```text
sees ein's seat session?  YES
POST /session/:id/message -> 200, model called
POST /session/:id/shell   -> 200, side effect ran
plugin hooks fired:       0
```

`--pure` skips project-local plugins under `.opencode/plugin/`, not merely npm ones. So neither the plugin
guard nor the server password constrains a second instance: the guard never loads, and the password is a
property of a server process the operator just started themselves.

A plain `opencode` with no flags does load the project plugin, so the _casual_ path — open a shell pane, start
the TUI, pick ein's session from the list, type — is blocked by the guard. `--pure` sits in the same
deliberate-act category as reading `/proc/<pid>/environ`.

### 5. Three transport controls exist and compose (verified)

| Control                            | Effect                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `OPENCODE_SERVER_PASSWORD`         | HTTP Basic, username `opencode`; `401` on every route including `/shell` |
| `OPENCODE_DB=<private path>`       | Private session storage; other instances cannot reach the seat at all    |
| `OPENCODE_DISABLE_EMBEDDED_WEB_UI` | Stops the server also serving a browser cockpit (not yet exercised)      |

`OPENCODE_DB` is the strongest of the three because it closes the vector at its root rather than guarding each
route into it. With the seat server on a private database, a second `--pure` instance in the same directory
could not reach the session even by explicit ID:

```text
lists ein's seat?              no (6 sessions in default db)
GET  /session/<id>          -> 404
POST /session/<id>/message  -> 404, 0 model calls
POST /session/<id>/shell    -> 404, no side effect
```

There is no Unix socket option: `--hostname` is TCP-only and a socket path fails with `ServeError`.

All three layers compose without interfering. On a seat server running a private database _and_ a password
_and_ the plugin, an authenticated caller still hits the guard:

```text
lease=human      prompt -> 200, modelCalls=1
lease=swordfish  prompt -> 500, modelCalls=0
```

### 6. A private database does not complicate legitimate attachment

`OPENCODE_DB` is server-side only — there is no `--db` flag on `attach`, because the client is a thin TUI over
the HTTP API and the server owns storage. Connecting needs the URL, the session ID, and the credential:

```bash
opencode attach http://127.0.0.1:<port> --session <session-id> --password <credential>
```

Verified against a seat server running a private database and a password:

```text
attach, no credential                        -> "Session not found"
attach -s <id> -p s3cret                     -> connected, TUI renders
OPENCODE_SERVER_PASSWORD=... attach -s <id>  -> connected
```

Two details matter for the cockpit design. First, the unauthenticated failure is `Session not found`, not
`Unauthorized` — isolation and auth failure are indistinguishable from outside, so `sf` should say which one it
is. Second, `--password` **defaults to `OPENCODE_SERVER_PASSWORD`** (and `--username` to
`OPENCODE_SERVER_USERNAME`, default `opencode`), so exporting the variable into the tmux session environment
would silently re-grant seat write access to every free shell pane.

This is what makes the credential usable as a takeover token: it is the only thing standing between a shell
pane and the seat, it can be handed out deliberately, and rotating it revokes every client holding it.

## Consequences for the design

1. **`SYSTEM.md` §11.5's third layer is cheap, not architectural.** Two environment variables set by Swordfish when it
   spawns OpenCode — `OPENCODE_DB` for a private seat database and `OPENCODE_SERVER_PASSWORD` for a random
   per-boot secret — cover the shell route and the second-instance route respectively. Neither a reverse proxy
   nor OS user separation is required for the MVP.
2. **A Swordfish reverse proxy should be deferred** until cockpit v2 needs an HTTP policy point. If it is built,
   it should pass through with per-route lease policy and default-deny only _unknown_ routes while a lease is
   held, rather than maintaining an allowlist that must track OpenCode's API surface across upgrades.
3. **OS user separation is not worth its cost here.** It is the only thing that makes bypass genuinely
   impossible, but it contradicts `SYSTEM.md` §16.1's free shell panes, and an operator with sudo reopens it anyway.
   The threat model in §21.1 is accidental interference by a trusted operator, not an adversary.
4. **The seat password is a capability, not configuration.** Bind its lifetime to the control lease: never
   publish it, issue it only through `sf takeover`, and rotate it on every control release — `sf handback`, the
   `/auto` `set_spec` transition, and role-aware plugin handback — when one was issued during that episode.
   Without rotation, a single takeover grants permanent shell-route access and every later lease is advisory.
   Rotation costs a seat-server restart, since the variable is read at process start; sessions survive it via
   `OPENCODE_DB`, but seat panes and the event subscription must be re-established. `SYSTEM.md` §11.5 records this.
5. **Detection belongs in the design regardless.** Swordfish already consumes the OpenCode event stream, and it
   knows which prompts it originated. Any message or tool execution on a leased seat that Swordfish did not
   originate is an intrusion, and that invariant is route-agnostic — it catches future unhooked routes that an
   enumerated guard would miss. Shell invocations were observable as `tool`-part messages.
6. **Milestone 7's lease-guard scenario should assert `modelCalls == 0`**, not just a rejection status. A guard
   that denies after the provider call would still burn budget and mutate context.
7. **Milestone 8's cockpit work should not treat the tmux lock as defence in depth for the shell route**, and
   the base image must set the password, the private database, and `--mdns` off with `--cors` empty.

## Running it

Requires `opencode` 1.18.5 on `PATH`. No model credentials — the prototype serves its own OpenAI-compatible
endpoint and fails loudly if anything else is contacted.

```bash
vp run @bebop/prototype-lease-guard#prototype
```

Writes `results.json` (per-probe outcomes, session messages, hook audit) next to this file. Both are gitignored.

## Layout

| Path                                      | Purpose                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `fake-model.ts`                           | OpenAI-compatible endpoint that counts every request                   |
| `run.ts`                                  | Driver: starts both servers, probes each route under both lease states |
| `project/`                                | Throwaway workspace OpenCode is pointed at                             |
| `project/.opencode/plugin/lease-guard.ts` | The guard under test                                                   |
| `project/.opencode/command/spike.md`      | A real slash command, so the `/command` route is exercised honestly    |

This is a prototype, not product code. The real guard lands in `apps/bebop-opencode-plugin` during Milestone 7.
