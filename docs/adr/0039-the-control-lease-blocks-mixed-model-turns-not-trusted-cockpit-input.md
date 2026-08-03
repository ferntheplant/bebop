# The control lease blocks mixed model turns, not trusted cockpit input

This supersedes [The control lease is enforced in four independent layers (ADR 0009)](./0009-the-control-lease-is-enforced-in-four-layers.md).

The control lease prevents a human and Swordfish from submitting model turns to the same seat concurrently; it
does not make the OpenCode TUI or the bounty VM read-only. A Swordfish-controlled seat remains keyboard-enabled
in tmux. The OpenCode plugin rejects ordinary human prompts before the provider is contacted, isolated seat
storage and credentials prevent an ambient second client from driving the seat, and Swordfish treats any seat
mutation it did not originate as an intrusion.

The previous design also disabled tmux input as a UX layer. That stopped accidental TUI actions but did not
protect the worktree: the cockpit deliberately includes unrestricted shell panes, and any operator could
re-enable tmux input or modify the same files from a shell. The extra mechanism therefore did not enforce an
authority the rest of the cockpit promised.

## Consequences

OpenCode actions outside prompt submission may take effect before Swordfish can react. Shell execution, session
abort, revert, and unrevert are detected from the seat event stream; an unexpected action records intrusion
provenance and suspends the current stage as `needs_attention`. Detection does not pretend to roll back the
side effect. Status names takeover followed by reconciled handoff, or cancellation, as the safe exits.

The tmux status line always identifies the workflow controller. While Swordfish controls the active seat it
also says to run `sf takeover` from a shell, because the plugin's denial reason does not survive through
OpenCode as useful caller-facing text. Tests must continue to prove that denied prompts make zero provider
calls and must separately prove the event signatures used to detect unsupported seat mutations.

The completed tmux input-lock prototype remains evidence that input disabling works; it is no longer a product
requirement. The pinned OpenCode event probe under `prototypes/opencode-seat-mutation-events` is the primary
source for the mutation signatures this decision relies on.
