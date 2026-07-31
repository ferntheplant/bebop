# Bun-specific APIs are imported by submodule, never through a barrel

`@effect/platform-bun` is imported by submodule. Its barrel re-exports `BunRedis` and therefore imports the `bun` module at load time, making anything that touches the barrel unloadable wherever Bun is not the runtime. `node:crypto` is used for hashing for the same reason: it works under both runtimes, and hashing is not where a Bun-specific API earns its keep.

## Consequences

Tidying these imports back to the barrel breaks loading, not type checking, so it fails late and in a confusing place. Both CLIs must also supply `BunStdio.layer` explicitly — `Command.run` reads argv from the `Stdio` service, which `BunRuntime.runMain` does not provide, and without it every invocation fails at startup including `--help`.
