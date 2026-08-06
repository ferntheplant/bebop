---
type: task
status: open
---

# Provision exe.dev access and record where its credentials live

Resolving this updates [Provisioning and attachment](../../../docs/capabilities/02-provisioning-and-attachment.md).

## Question

Nothing about exe.dev can be judged without an account, an API key, and at least one VM that can actually be
created and destroyed. This ticket exists to unblock the ones that follow, not to decide anything.

Done when:

- an exe.dev account exists with billing configured and its limits known;
- an API key is issued and stored where bebop's deployment will read it from — record _where_, since
  [The master runs on exe.dev (ADR 0019)](../../../docs/adr/0019-the-master-runs-on-exe-dev-with-mandatory-off-vm-backups.md) says the key
  is held only on the master;
- one VM has been created, attached to over SSH, stopped, and destroyed by hand;
- the LLM and HTTP Proxy integrations are enabled on the account, so the [LLM integration](./exe-dev-llm-integration-for-ein-and-jet.md) and [HTTP Proxy](./exe-dev-http-proxy-for-opencode-go.md) tickets can be worked;
- the resulting facts — account identifiers, region or host constraints, key location, observed quotas — are
  recorded in the answer.
