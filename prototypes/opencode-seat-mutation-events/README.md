# Prototype: OpenCode seat-mutation events

**Status:** Complete — detection confirmed

**Date:** 2026-08-03

**Pinned OpenCode version:** 1.18.5

## Question

If a Swordfish-controlled seat remains writable in tmux, can Swordfish identify shell execution, turn abort,
session revert, and session unrevert through OpenCode's event stream after rejecting ordinary prompts through
the plugin?

This probe uses the exact OpenCode CLI version, a local scripted model endpoint, and no provider credential.

## Verdict

Confirmed. Every known keyboard-driven seat mutation that bypasses prompt hooks has a distinguishable event
signature in OpenCode 1.18.5:

| Action    | Distinguishing observation                   |
| --------- | -------------------------------------------- |
| TUI shell | assistant `tool` part                        |
| abort     | assistant message with `MessageAbortedError` |
| revert    | `session.updated` adds a `revert` marker     |
| unrevert  | `session.updated` removes the marker         |

Swordfish can compare those events with the commands it originated and escalate any unmatched mutation as an
intrusion. Detection happens after the mutation and provides no rollback.

## Running it

```bash
vp run @bebop/prototype-opencode-seat-mutation-events#prototype
```
