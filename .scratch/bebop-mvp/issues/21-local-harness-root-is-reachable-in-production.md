# Should `BEBOP_LOCAL_HARNESS_ROOT` be impossible in production rather than merely warned about?

Type: task
Status: open

## Question

`BEBOP_LOCAL_HARNESS_ROOT` is an optional key on the real `BebopConfigBase` schema, read by the real
`LocalLifecycleProviderLayer` that `api.ts` and `worker.ts` both provide. When it is set, every
`LifecycleProvider.provision` writes the bounty's plaintext Swordfish machine credential to a file under that
root.

That is correct and deliberate locally: it is
[Swordfish tokens are bounty-scoped, minted at provisioning, and never rotate (ADR 0014)](../../../docs/adr/0014-bounty-scoped-swordfish-tokens-minted-at-provisioning.md)
applied at a seam where the VM is a directory, and it is what lets
[the local system harness](../../local-system-harness/brief.md) start a real Swordfish without inventing a second
credential path or an operator retrieval route.

What is unresolved is the blast radius of the same env var being set anywhere else. Today the only protection is
a startup `Effect.logWarning` in `apps/bebop/src/runtime/layers.ts`. A warning is not a guard: it is one line in
a structured log stream that nobody reads on a healthy boot, and the failure it is warning about — every
provisioned bounty's machine credential sitting in plaintext on the master's disk — is silent, durable, and
retroactive across every bounty provisioned while it was set.

Decide between:

- **Leave the warning.** The option only does anything on the _fake_ provider, which creates no computer and is
  itself never meant to run in production. Cheapest, and arguably the exposure is bounded by the fake provider
  already being a non-production component.
- **Fail closed on a production marker.** Refuse to construct the layer when the config says production. Bebop
  has no environment marker today, so this means introducing one — which is a wider decision than this ticket,
  and one worth making deliberately rather than as a side effect.
- **Move it off the production schema entirely.** Keep the artifact behaviour on `fakeLifecycleProviderLayer`'s
  options, where it already lives, and let the harness construct that layer directly instead of routing the
  option through `BebopConfiguration`. Removes the production reachability rather than guarding it, at the cost
  of the harness no longer driving the same packed entrypoints an operator runs — which is the property the
  harness exists to have.

The third option is the one that actually dissolves the problem, and its cost is the one that needs weighing:
the harness's value comes from launching the real `api.mjs` and `worker.mjs`, so anything that makes the harness
configure the provider out-of-band weakens what it proves.

## When this resolves

Naturally when the real exe.dev provider lands and the fake provider stops being the one that runs — at which
point the option can likely be deleted outright rather than guarded. Revisit no later than that. Until then this
is a recorded, accepted risk rather than an oversight.

Raised during review of [the maintained local system harness](../../local-system-harness/brief.md); see
`apps/bebop/src/config.ts` and `apps/bebop/src/runtime/layers.ts`.
