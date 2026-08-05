# The security model

What a bounty VM is allowed to do, and what it can never do no matter how badly its cowboys are behaving. The
whole design rests on one line: **high-value authority stays outside the sandbox**, so a confused or compromised
bounty cannot merge code, provision computers, or reach another bounty.

## Who this is for

Bebop is single-user or trusted-small-team software, operating on repositories the operator owns. It is not
multi-tenant, and it does not try to defend one user's bounty from another user's. Multitenant billing,
enterprise RBAC, and organisation administration are explicit non-goals.

## What is treated as untrusted

Everything a model reads. Repository content, task prompts, external web pages, logs, Sentry events, analytics
data, and MCP results are all untrusted input — none of them carry authority, and none of them can talk the
system into granting any.

## What a bounty VM may receive

- read and limited write access to **one** repository, through exe.dev's repository-scoped integration;
- model access through the exe.dev LLM and HTTP Proxy integrations;
- the context integrations you selected at creation;
- a bounty-scoped Swordfish connection token;
- a salted verifier for its per-bounty operator credential; plaintext enters only transiently through hidden
  human terminal input, never through provisioning or persisted configuration;
- its own local development services.

## What a bounty VM must never receive

- exe.dev account credentials;
- bebop's GitHub App credentials;
- protected-branch bypass authority;
- pull-request merge authority;
- master Postgres credentials;
- evidence-sink credentials;
- unrestricted infrastructure credentials;
- authority to provision sibling VMs;
- authority to attach new integrations.

The sandbox may _report_ that it needs another capability, but it cannot attach or grant one. Capability changes
require a bebop action and become bounty metadata.

## Who may call the API

Two independent layers:

1. **Private ingress.** The API is reachable only through its exe.dev private URL, so exe.dev's own
   authentication is the first gate and there is no public surface at all.
2. **Named bearer tokens** issued by bebop — `fern-cli`, later `linear-bot` — stored hashed in Postgres, checked
   on every request, and individually revocable. Revocation takes effect on the next request, not at the next
   restart.

A token's plaintext exists exactly once, in the response that creates it; listing returns metadata only. A fresh
database is bootstrapped with one token from `BEBOP_BOOTSTRAP_API_TOKEN`, consumed only while the token table is
empty — once any token row exists, startup never recreates or un-revokes a token from environment configuration,
so the bootstrap value can be removed from the deployment once real client tokens exist.

`GET /api/health` is the single unauthenticated route, and exposes liveness and nothing else.

## What you should still expect to be true

- **Integrations are VM-scoped, not seat-scoped.** Every process in an attached VM can invoke every attached
  integration — faye's OpenCode Go proxy is reachable from ein's seat and from any free shell pane, even though
  only faye is configured to use it. Attach only the integrations a bounty actually needs, and never rely on
  `auto:all` defaults.
- **Keeping a token off the VM does not reduce what the VM can do with it.** A credential-injecting proxy stops
  the sandbox reading a reusable secret; it does not stop the sandbox spending that secret's quota. Seat
  capability selection still matters.
- **A writable sandbox can modify unprotected refs** in its allowed repository. Branch protection on the merge
  target is the mitigation, not sandbox restraint.
- **The control lease can be bypassed by a determined operator with a shell in the VM.** That is accepted; the
  goal is that it cannot happen by accident.

## Where it stands

**Designed, and partly load-bearing already.** The authority split is real in code — bebop holds merge authority
and refuses to exercise it without GitHub, and Swordfish's token is bounty-scoped and derived. Everything
involving a real VM, real integrations, and real credentials is unbuilt.

## Acceptance criteria

**None directly.** This capability is a property of every other one rather than a stage with its own test, and
that is worth noticing: nothing in [`ABSTRACT.md`](../../ABSTRACT.md) §8 fails if the must-never-receive list is
violated. The criteria that come closest are **3** (the VM receives only configured integrations) and **38** (the
sandbox cannot update the protected merge target).

## Decisions

- [The VM is the sandbox (ADR 0012)](../adr/0012-the-vm-is-the-sandbox.md) — the isolation seam is the computer,
  not the harness, and high-value authority staying outside it is what pays for ein running allow-all inside.
- [Readiness is a claim, not authority (ADR 0003)](../adr/0003-readiness-is-a-claim-not-authority.md) — if bebop
  trusted the claim, the sandbox would effectively hold merge authority.
- [Bebop owns authority, Swordfish owns the loop (ADR 0002)](../adr/0002-bebop-owns-authority-swordfish-owns-the-loop.md)
  — the split follows the trust line, not the convenience line.
- [The control lease blocks mixed model turns, not trusted cockpit input (ADR 0039)](../adr/0039-the-control-lease-blocks-mixed-model-turns-not-trusted-cockpit-input.md)
- [Swordfish tokens are bounty-scoped (ADR 0014)](../adr/0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md)
  — a leaked token is bounded by its bounty's lifetime.
- [Swordfish connects outbound only (ADR 0013)](../adr/0013-swordfish-connects-outbound-only.md) — private
  ingress removes an attack surface from a service holding merge authority.

Configuration tampering is handled by [repository configuration](./07-repository-configuration.md); merge
integrity by [pull request and merge](./12-pull-request-and-merge.md); seat permission profiles by
[code review](./09-code-review.md) and [QA](./10-qa.md).

## Still open

- What GitHub App permissions are actually needed, and how is the target branch protected?
- Can the exe.dev HTTP Proxy serve OpenCode Go to faye with an injected credential?
  — the credential-off-VM rule is not considered implemented until this passes a provisioning smoke test.
