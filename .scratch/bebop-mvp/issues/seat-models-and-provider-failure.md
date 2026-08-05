---
type: grilling
status: open
blocked-by: [exe-dev-llm-integration-for-ein-and-jet, exe-dev-http-proxy-for-opencode-go]
---

# Which model does each seat run, and what happens when it can't be reached?

## Question

The provisional answer is ein on GPT-5.6 Sol at high effort, jet on the same at medium, faye on GLM 5.2
through the HTTP Proxy. It was adopted as a recommended default without operator review,
and the [LLM integration](./exe-dev-llm-integration-for-ein-and-jet.md) and [HTTP Proxy](./exe-dev-http-proxy-for-opencode-go.md) tickets may make parts of it impossible.

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
