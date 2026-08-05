---
status: open
---

# Brief: promote the spawn-and-collect helper into @bebop/testkit

## Background

Fallow's duplication detector found the same spawn-and-collect idiom — spawn a process, then read its
stdout, stderr, and exit code through `Promise.all([new Response(child.stdout).text(), ...])` — copied in
`apps/bebop/scripts/smoke.ts`, `apps/swordfish/scripts/smoke.ts`, and four prototype drivers. The prototype
copies are throwaway and stay ignored by design
[Prototype duplication is expected (ADR 0045)](../../../docs/adr/0045-prototype-duplication-is-expected.md). The
two real smoke scripts are a second-consumer case for
[Code moves to a package on its second consumer (ADR 0007)](../../../docs/adr/0007-code-moves-to-a-package-on-its-second-consumer.md).

## Scope

- Add a spawn-and-collect helper to `@bebop/testkit`, a new `src/spawn.ts` re-exported from
  `packages/testkit/src/index.ts` next to `waitForSwordfishControl`.
- Use it in `apps/bebop/scripts/smoke.ts` and `apps/swordfish/scripts/smoke.ts`, deleting their inline copies.
- Leave the prototypes alone: their copies are expected throwaway boilerplate (ADR 0045).

The two call sites disagree on shape — bebop reads `{ stdout, stderr, exitCode }` and checks them inline;
swordfish's `run()` returns `{ code, stdout, stderr }` and throws at the call sites. Settle on one shape:
return the collected result and let callers decide whether to throw covers both.

## Done when

- `@bebop/testkit` exports the helper and both smoke scripts import it, with the inline copies gone.
- `vp run ready` passes and the artifact smokes still pass.
- `fallow dupes` reports no duplication involving the smoke scripts.

## Comments

Opened 2026-08-05 from Fallow adoption: the dupe groups only surfaced because the prototype copies padded the
count above `minOccurrences: 3`; ignoring `prototypes/**` hid them, so this extraction is what keeps the real
duplication honest.
