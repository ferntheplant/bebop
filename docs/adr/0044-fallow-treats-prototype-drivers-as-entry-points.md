# Fallow treats prototype drivers as entry points, not dead code

A prototype is a throwaway spike: a workspace package whose only real entry point is its `run.ts` driver,
invoked with `bun run.ts`. Its `package.json` declares no `main`, `exports`, or `bin`, so Fallow sees a package
with no roots and reports every file in it as `unused-file` — including the driver itself. Suppressing that with
`ignorePatterns: ["prototypes/**"]` or `rules` overrides would also silence the dead code inside a prototype we
do want caught.

So `entry` names `prototypes/*/run.ts`: each driver is a real entry point, and reachability analysis runs
_inside_ each prototype the same way it runs inside an app. A file that is genuinely unreachable from its own
driver's graph stays reported as dead code.

Drivers also load files no static import ever references — child processes spawned with
`spawn(["bun", `${here}/file.ts`])` or `bun ${here}/file.ts`, migrations loaded from the filesystem, and the
opencode plugin the pinned server discovers. Those are runtime entry points, so `dynamicallyLoaded`names them,
scoped to`prototypes/**` so the apps stay strict.

## When to add a new exemption

Add a `dynamicallyLoaded` entry when a prototype driver loads a file at runtime **and** no static import
references it. The test is whether the file is invoked at runtime by its prototype's driver: child-process
spawns, filesystem-loaded modules, and runtime-discovered plugin files qualify. Scope it to `prototypes/**`.

A file that is merely unreachable within its prototype — reachable from neither a static import nor a driver
spawn — is real dead code, not an exemption. Delete it or wire it up; `@expected-unused` is the tool for a file
you are keeping on purpose.

## Anti-rules

- Do not grow `ignorePatterns` or turn off `unused-*` rules for `prototypes/**`; that is the debt that ends
  clean-code checking in the prototypes entirely.
- Do not add entries for files a driver does not actually load; an unused `dynamicallyLoaded` glob silently
  keeps dead files alive forever.

## Consequences

Every prototype reports two kinds of findings: runtime-loaded files modeled in `dynamicallyLoaded`, and real
dead code that stays visible until deleted. Adding a new `fake-*.ts` helper or `seat-program.ts` needs no config
change — the patterns already cover the convention — while a genuinely new kind of runtime loading needs one
scoped entry.
