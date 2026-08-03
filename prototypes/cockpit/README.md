# Prototype: operator-shaped cockpit

**Status:** Complete — layout confirmed

**Date:** 2026-08-03

## Question

Can the cockpit start as one full-screen active cowboy seat, keep essential workflow state in tmux's status
line, add fresh seat windows without stealing focus or changing operator-created panes, and fall back to a shell
with one status snapshot when no cowboy is active?

The prototype deliberately does not create a status window, service-log windows, or a preferred split layout.

## Verdict

Confirmed. The initial active-seat window contains one pane. Adding a fresh managed seat leaves the current
window selected and preserves an operator-created split and window. A no-cowboy stage can direct a new
attachment to a landing shell without changing existing clients, and service logs need only expose a stable
follow command.

## Running it

Requires Docker. The disposable container installs tmux because the host need not provide it.

```bash
vp run @bebop/prototype-cockpit#prototype
```
