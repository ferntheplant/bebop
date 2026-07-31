# Can the exe.dev HTTP Proxy serve OpenCode Go to faye with an injected credential?

Type: research
Status: open

## Question

faye's model is planned to arrive through exe.dev's generic HTTP Proxy integration, which injects an
authorization header so the reusable OpenCode Go key never sits on a bounty VM — the
[credential-off-VM rule](../../../docs/capabilities/14-the-security-model.md) is not considered implemented
until this passes.

Establish, against the live integration:

- whether it injects authorization on every proxied route or only some;
- whether it streams — a proxy that buffers a token stream makes the seat unusable;
- whether client cancellation propagates to the upstream request, or whether an aborted turn keeps billing;
- how it joins paths, and whether a crafted path can escape the configured upstream prefix;
- what the error surface looks like when the upstream rejects, so Swordfish can distinguish "model refused"
  from "proxy misconfigured".

The same mechanism is the general answer for any credentialed third-party service a seat needs, so the finding
outlives faye.
