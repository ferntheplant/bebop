# Can the exe.dev LLM integration serve ein and jet through the connected ChatGPT subscription?

Type: research
Status: open

## Question

`docs/design/SYSTEM.md` §14.1 and §20.2 assume ein and jet reach a frontier model through exe.dev's LLM
integration, using its OpenAI strategy against a connected ChatGPT subscription, with no reusable API key ever
landing on a bounty VM. That assumption has never been tested against the live product.

Establish:

- whether the OpenAI strategy actually serves subscription-backed models to a process running on an exe.dev VM,
  and which models;
- what the credential looks like from inside the VM, and whether it is scoped to the VM or reusable off it;
- whether OpenCode can be configured to use it as a provider without a custom adapter;
- what happens on quota exhaustion or subscription interruption — the failure mode, not just the happy path;
- whether streaming and cancellation behave the way OpenCode's client expects.

If the answer is no, the fallback shape (direct API keys held by bebop and injected per bounty) is a different
security model, so record what it would cost.
