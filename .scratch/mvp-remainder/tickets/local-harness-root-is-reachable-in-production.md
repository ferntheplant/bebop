---
type: grilling
status: open
---

# Should `BEBOP_LOCAL_HARNESS_ROOT` be impossible in production rather than merely warned about?

Resolving this updates [Provisioning and attachment](../../../docs/capabilities/02-provisioning-and-attachment.md).

## Question

`BEBOP_LOCAL_HARNESS_ROOT` is an optional key on the real `BebopConfigBase` schema, read by the real
`LocalLifecycleProviderLayer` that `api.ts` and `worker.ts` both provide. When it is set, every
`LifecycleProvider.provision` clones a repository and spawns a detached Swordfish daemon on bebop's own host.

That is correct and deliberate locally: it is
[A local Swordfish outlives the worker that started it (ADR 0048)](../../../docs/adr/0048-a-local-swordfish-outlives-the-worker-that-started-it.md),
which is what makes the loop runnable by hand at all.

The original worry — that it wrote every bounty's plaintext machine credential to disk — is gone. ADR 0048
removed the bootstrap artifact: the credential now travels from derivation into the spawned process's
environment and is never written down. What remains is narrower but not nothing. Set anywhere else, this makes
an always-on service that holds merge authority also a service that clones arbitrary repositories and spawns
long-lived processes on its own host, and the daemons it spawns outlive it by design. The only protection is a
startup `Effect.logWarning` in `apps/bebop/src/runtime/layers.ts`, which is one line in a structured log stream
nobody reads on a healthy boot.

Decide between:

- **Leave the warning.** The option only does anything on the _fake_ provider, which is itself never meant to
  run in production. Cheapest, and arguably the exposure is bounded by the fake provider already being a
  non-production component. Cheaper than it was, now that no credential reaches disk.
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

Raised during review of [the maintained local system harness](../../../docs/testing.md); narrowed when ADR 0048
removed the on-disk credential. See `apps/bebop/src/config.ts` and `apps/bebop/src/runtime/layers.ts`.
