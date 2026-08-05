# Prototype duplication is expected, not a shared-code opportunity

Fallow's duplication detector sees the same boilerplate copied across prototype drivers — the
spawn-and-collect-and-throw idiom and the probe-results summary. Spike drivers reuse these idioms by design:
a prototype is a throwaway, standalone experiment, and that independence is the point of the directory.

So `duplicates.ignore` names `prototypes/**`. Cross-spike duplication is not reported, and the prototypes are
not refactored to share code. A shared home for spike code would be a permanent home for throwaway code, and
coupling spikes together means throwing one away breaks the others — the opposite of why the directory exists.
When a spike's idea wins, the code moves to a package for its first real consumer (ADR 0007), and that package
is where duplication is fixed for real.

## The boundary

The ignore is scoped to `prototypes/**` on purpose. The moment a spike idiom shows up in real app code it
stops being throwaway: the spawn-and-collect helper appears in both `apps/bebop/scripts/smoke.ts` and
`apps/swordfish/scripts/smoke.ts`, which is the second-consumer moment
[Code moves to a package on its second consumer (ADR 0007)](./0007-code-moves-to-a-package-on-its-second-consumer.md)
exists for. That helper belongs in `@bebop/testkit` next to `waitForSwordfishControl`, and the smoke scripts
import it rather than copy it. Ignoring prototypes must never be used to hide a duplication that also exists
between real files — the detector losing the signal is exactly when a promotion is being missed.

## Anti-rules

- Do not create a shared `prototypes/` package or helper; a spike that depends on another spike cannot be
  thrown away.
- Do not widen `duplicates.ignore` past `prototypes/**`; real app duplication stays reportable.
