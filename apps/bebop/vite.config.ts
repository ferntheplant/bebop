import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/api.ts", "src/worker.ts", "src/cli.ts"],
    format: ["esm"],
    sourcemap: true,
  },
  run: {
    tasks: {
      // The artifacts are real programs now — two of them want a database and stay up — so
      // the smoke asserts that each packed bundle loads and reaches its own code rather than
      // that it prints its name. See `scripts/smoke.ts`.
      smoke: {
        command: "bun scripts/smoke.ts",
        dependsOn: ["build", { task: "build", from: ["dependencies", "devDependencies"] }],
      },
    },
  },
});
