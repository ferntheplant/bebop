# Spike: tmux pane input lock

**Status:** Complete — assumption **confirmed**, and its ceiling measured

**Date:** 2026-07-26

**Pinned version:** tmux 3.7b

**Assumption under test:** [`SPEC.md`](../../SPEC.md) §16.2 — "tmux disables keyboard input to seat panes whose
lease Swordfish holds (UX layer)", without giving up §16.1's "seat panes — the real OpenCode TUIs for ein, jet,
and faye, visible at all times".

**PLAN reference:** Milestone 0, "Prove tmux can disable input to one pane without hiding its output."

## Verdict

**Confirmed.** `select-pane -d` disables input to a single pane while that pane keeps producing output, keeps
rendering live in an attached client, and keeps its scrollback available through copy mode. 11/11 probes pass.
This is exactly Milestone 8's exit criterion "a user can observe a working seat but cannot type into its pane
while Swordfish holds the lease".

The lock is also **trivially reversible by anyone in the session** (T11). That is not a defect — SPEC §16.2
already labels this layer "UX" — but it does fix how much the cockpit may rely on it, which finding 4 covers.

| Probe | Question                                                                    | Result                        |
| ----- | --------------------------------------------------------------------------- | ----------------------------- |
| T1    | with input enabled, `send-keys` reaches the seat program                    | delivered                     |
| T2    | `select-pane -d` reports the pane as input-disabled                         | `pane_input_off=1`            |
| T3    | while disabled, `send-keys` does **not** reach the seat program             | blocked                       |
| T4    | while disabled, the pane keeps producing output                             | tick 14 → 19                  |
| T5    | while disabled, `paste-buffer` does **not** reach the seat program          | blocked                       |
| T6    | while disabled, copy mode still opens for scrollback                        | 24 lines of history           |
| T7    | a **real attached client**'s keystrokes reach the seat program when enabled | delivered                     |
| T8    | while disabled, a real client's keystrokes do **not** reach it              | blocked                       |
| T9    | the attached client keeps rendering live output while disabled              | tick 44 → 49, seen by client  |
| T10   | the lock survives detach, a fresh attach, and a layout resize               | held through all three        |
| T11   | any pane in the session can clear the lock with `select-pane -e`            | **cleared, keystroke landed** |

## Findings

### 1. The mechanism is one documented flag, not a workaround (confirmed)

`select-pane -e` / `-d` "enables or disables input to the pane", and `#{pane_input_off}` reports the state, so
Swordfish can both set and verify the lock without scraping anything. It is per-pane, which is what §16.1's
layout needs: seat panes lock while free shell panes in the same window stay usable.

Output is entirely unaffected. The pane's program keeps running and writing (T4), and — the half that actually
matters — an attached client keeps _rendering_ those writes while the lock is on (T9, measured through the
client's own terminal rather than through the seat server). "Observe but do not steer" is a real state in tmux,
not something the cockpit has to simulate.

### 2. The lock covers every tmux input path tested, including programmatic ones (confirmed)

Three routes into the pane were probed under lock and all three were refused:

| Route                  | Locked behaviour |
| ---------------------- | ---------------- |
| real client keystrokes | blocked          |
| `send-keys`            | blocked          |
| `paste-buffer`         | blocked          |

`paste-buffer` is the one worth calling out: it is how an accidental middle-click or a `]` reflex delivers a
block of text, it does not look like typing, and it is blocked too.

That `send-keys` is blocked also means the lock is not a control path Swordfish can drive through. This costs
nothing — Milestone 7's exit criteria already require that "all automation uses the HTTP API and events; PTY
keystrokes are not a control path" — but it does mean Swordfish must `select-pane -e` before any pane-level
automation, and there should not be any.

### 3. The lock is a pane property and survives client churn (confirmed)

T10 detached the client, attached a **fresh** one, and reflowed the layout with a split. `pane_input_off` stayed
1 across all three, and a keystroke from the new client was still refused. Two consequences:

- an operator who drops SSH and reconnects does not silently regain write access, which is what §16.4's
  "disconnecting SSH does not imply handback" needs from this layer;
- Swordfish does not have to re-apply the lock on client connect, so there is no window between attach and
  re-lock for a keystroke to slip through.

### 4. Any pane in the session can clear the lock, so it must not be load-bearing (confirmed, by design)

T11 ran `tmux select-pane -e` from an ordinary shell pane in the same session and the very next keystroke
reached the seat program. No privilege was needed beyond talking to the tmux server — which every free shell
pane can do by definition, since it is the server hosting them.

There is no tmux-side fix worth having. Locking down the server socket would break §16.1's free shell panes,
which exist precisely so the operator can explore the VM.

This is the same shape as the lease-guard spike's conclusion and it points the same way: the tmux lock stops
the _accidental_ keystroke, which is the stated threat model in §21.1, and the authoritative refusals live in
the plugin and the seat server's password and private database (§11.5). SPEC §16.2 already orders the layers
this way. The spike confirms the ordering is necessary rather than merely cautious.

### 5. A headless test of a client-side input path needs a real client (process finding)

`send-keys` does not exercise the code path a keystroke takes. Proving the operator's experience requires an
attached client on a real terminal, and the obvious tool does not work: macOS `script` calls `tcgetattr` on its
own stdin and fails with `Operation not supported on socket` when fed a pipe or FIFO.

The spike uses tmux to test tmux. A second tmux server on its own socket runs `tmux attach` against the seat
server inside one of its panes, which gives the inner client a genuine pty. Keystrokes sent to the outer pane
arrive at the inner client as terminal input and go through its ordinary key handling.

Two details this cost, both worth knowing before Milestone 8 writes its cockpit tests:

- the host session needs an idle keeper pane, because a tmux server whose last pane exits shuts down — and
  detaching the inner client ends the attach pane's command;
- respawning a client into the same pane needs `remain-on-exit on`, or tmux removes the pane when the attach
  ends and there is nothing left to respawn into.

Both servers start with `-f /dev/null`, and the free shell pane runs an explicit `/bin/sh`, so neither the
developer's tmux configuration nor their login shell can change the result (PLAN §8).

## Consequences for the design

1. **SPEC §16.2's first bullet is implementable as written.** No compromise between locking and observing is
   required, and no custom pane wrapper is needed.
2. **Swordfish sets the lock once per lease transition, not per client connect** (finding 3).
3. **Milestone 8's exit criterion "a user can observe a working seat but cannot type into its pane" should be
   asserted against the seat program's received input**, not a terminal snapshot. A pane can look untouched
   while the program behind it has already consumed the keystroke; the sentinel file is what distinguishes them.
4. **The cockpit must not present the tmux lock as protection.** `sf status` should report the lease, and the
   authority for refusal stays where §11.5 puts it.

## Running it

Requires `tmux` on `PATH`. No network access, no credentials, no containers.

```bash
vp run @bebop/spike-tmux-input-lock#spike
```

Exits nonzero if any probe fails. Writes `results.json` next to this file; it and the `.spike/` scratch
directory (private sockets and the input sentinel) are gitignored. Both tmux servers are killed before the run
starts and in a `finally` block, so an interrupted run cannot leak a server or feed the next one.

## Layout

| Path              | Purpose                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `run.ts`          | Driver: builds both tmux servers, runs all 11 probes, reports and tears down      |
| `seat-program.ts` | Stands in for a seat TUI: prints continuously, records whatever reaches its stdin |

This is a spike, not product code. The real cockpit lands in `apps/swordfish` during Milestone 8.
