---
type: grilling
status: open
---

# Which model does each seat run, and what happens when it can't be reached?

Resolving this updates [Autonomous implementation and revision](../../../docs/capabilities/06-autonomous-implementation.md), [Code review](../../../docs/capabilities/09-code-review.md).

## Question

The provisional answer is ein on GPT-5.6 Sol at high effort, jet on the same at medium, faye on GLM 5.2
through the exe.dev HTTP Proxy. It was adopted as a recommended default without operator review.

**This ticket split when the map went local-first, and only the first half is here.** _Which_ model each seat
runs and what happens when one is unreachable are answerable now, against the operator's own credentials — the
loop cannot run without answering them. _How_ those models are delivered without a reusable key touching a VM
is the [remainder's](../../mvp-remainder/map.md) question, and it is why this ticket used to be blocked on the
[LLM integration](../../mvp-remainder/tickets/exe-dev-llm-integration-for-ein-and-jet.md) and
[HTTP Proxy](../../mvp-remainder/tickets/exe-dev-http-proxy-for-opencode-go.md) research. Answer the choice
here; leave the delivery mechanism alone, and record the answer so it survives a provider that later refuses to
serve one of these models.

Settle:

- the model and reasoning effort for each seat, and the reasoning for the _difference_ between ein and jet —
  an independent reviewer running a weaker configuration of the same model is a different claim than an
  independent reviewer running a different model;
- whether jet on a different vendor is worth the credential cost, or stays deferred;
- what happens mid-bounty when a provider is unavailable, rate-limited, or degraded: does the stage fail, wait,
  or escalate to `needs_attention`, and does that differ per seat;
- whether the model choice is bounty-configurable or fixed by the image, and who is allowed to change it;
- how a model change interacts with [Full invalidation (ADR 0016)](../../../docs/adr/0016-every-commit-invalidates-every-downstream-result.md)
  — is a review by a different model than the one recorded still a valid gate result?
