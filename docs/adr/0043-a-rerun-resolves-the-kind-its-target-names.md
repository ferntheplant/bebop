# A rerun resolves the kind its target names

A `rerun` clears exactly one outstanding attention record: the one whose kind its target addresses. `rerun
validation` answers an `uncertain_gate`; `rerun building`, `rerun review`, and `rerun qa` answer a
`constraint_exhausted`. Every other resolution keeps clearing every outstanding record that permits it.

Attention became a list of outstanding reasons, and a resolution clears every record permitting it, so that a
later laxer reason cannot widen the exits of an earlier stricter one
([Workflow actions have role-aware adapters (ADR 0038)](./0038-workflow-actions-have-role-aware-adapters.md)).
That rule is right for the resolutions it was written for. `takeover` genuinely answers every record that offers
it at once — a human is now driving all of it — and `resume` is offered only by kinds a resume does answer.
`rerun` is the exception, because it is the one resolution that carries a grant, and two kinds permit it.
Granting an ein attempt is no answer at all to a gate whose outcome nobody established, so a `rerun building`
issued while an uncertain gate stood would have cleared a reason nobody addressed.
[Constraint exhaustion is computed, not announced (ADR 0042)](./0042-constraint-exhaustion-is-computed-not-announced.md)
recorded the edge and left it open.

The target already distinguishes them, so nothing new has to be carried. `validation` is the only deterministic
operation a human reruns, and an uncertain _seat_ is a separate kind that permits no rerun at all — so the map
from target to kind is total and unambiguous. The alternative was to have `attention_cleared` name the kind
directly, which is more explicit and strictly worse: it admits an inconsistent pair, where the target grants an
attempt in one scope while the kind clears a record about something else, and the reducer would have to reject
a combination the emitter had no reason to produce.

## Consequences

`kindForRerunTarget` lives beside `resolutionsForAttention` in the contracts package, so the raise site, the
status that prints an attention's exits, and the reducer that admits a resolution cannot disagree about which
reason a rerun answers. A rerun whose target names a kind that is not outstanding is refused rather than
silently clearing something else, which is what makes a mistyped target a failed command instead of a lost
reason.

Clearing one record still leaves the others standing, so a bounty suspended for both an exhausted budget and an
uncertain gate takes two commands and resumes only after the second. That is the intended cost: each reason was
raised by something different, and each is answered by the person who addressed it.

A future attention kind that permits `rerun` has to extend this map, and it will be a compile error rather than
a silent widening — the map is total over the target set, so a kind with no target that names it can never be
cleared by a rerun at all.
