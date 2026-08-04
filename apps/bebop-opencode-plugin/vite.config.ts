import { defineConfig } from "vite-plus";
import { globalLogger } from "vite-plus/pack";

// `vp pack` prints "Build start" and "Cleaning N files" through `globalLogger`, whose level
// is only ever assigned inside tsdown's `build()` — which the `vp pack` CLI bypasses by
// calling the internal `buildWithConfigs()` directly. No config key or `-l` flag reaches it,
// so the config sets the level itself at load time. `pack.logLevel` below is a *different*
// logger and silences the rest. Both are needed until the upstream bypass is fixed.
globalLogger.level = "error";

export default defineConfig({
  pack: {
    logLevel: "error",
    entry: ["src/index.ts"],
    format: ["esm"],
    sourcemap: true,
  },
  run: {
    tasks: {
      build: "vp pack",
      smoke: {
        command: "bun -e 'await import(\"@bebop/opencode-plugin\")'",
        dependsOn: ["build", { task: "build", from: ["dependencies", "devDependencies"] }],
      },
    },
  },
});
