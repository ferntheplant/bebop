import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/api.ts", "src/worker.ts", "src/cli.ts"],
    format: ["esm"],
    sourcemap: true,
  },
  run: {
    tasks: {
      // `sh -c` keeps the executable artifact out of plan-time binary resolution,
      // which runs before `build` has produced `dist`.
      smoke: {
        command: ["bun dist/api.mjs", "bun dist/worker.mjs", "sh -c './dist/cli.mjs'"],
        dependsOn: ["build", { task: "build", from: ["dependencies", "devDependencies"] }],
      },
    },
  },
});
