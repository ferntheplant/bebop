# Continue preserves an attempt; rerun replaces it

Constraint recovery distinguishes preserving context from starting again. When the final allowed cowboy attempt
exhausts its watchdogs, Swordfish retains that seat and suspends the attempt in `needs_attention`. Authenticated
human `continue` revives the same attempt and resets both its turn and wall-clock watchdogs. Authenticated human
`rerun` abandons the suspended attempt, grants one additional attempt in that scope, and starts fresh autonomous
work.

The distinction is role-aware without changing seat continuity. `rerun building` starts a new ein attempt in
ein's durable seat; `rerun review` and `rerun qa` create fresh jet and faye seats. `rerun validation` repeats the
deterministic operation on the same SHA and consumes no cowboy attempt. A cowboy invoking `continue` during
healthy work stays within its current limits and cannot grant itself budget.

## Consequences

`resume` no longer carries a constraint-extension option. It clears only a safe non-budget suspension such as
`set-blocked`, preserves the attempt, and changes no allowance. `rerun` gains `building` alongside `validation`,
`review`, and `qa`.

Human recovery grants are intentionally unlimited but never implicit. Every watchdog reset and additional
attempt is separately authenticated, durably recorded, and visible in status. If more than one watchdog is
exhausted, `continue` resets the complete turn/time pair rather than asking the operator to revive an attempt
that remains blocked by the other dimension.

Taking over ends autonomous counting without refunding the attempt that started; handoff starts another attempt.
Human-controlled turns are unconstrained. A repository's frozen constraint profile supplies base allowances,
while recovery events form durable additions rather than mutating that profile.
