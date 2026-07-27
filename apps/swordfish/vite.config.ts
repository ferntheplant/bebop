import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/daemon.ts", "src/cli.ts"],
    format: ["esm"],
    sourcemap: true,
  },
  run: {
    tasks: {
      // `sh -c` keeps the executable artifact out of plan-time binary resolution,
      // which runs before `build` has produced `dist`.
      smoke: {
        command: ["sh -c './dist/cli.mjs'", "sh -c './dist/daemon.mjs'"],
        dependsOn: ["build", { task: "build", from: ["dependencies", "devDependencies"] }],
      },
    },
  },
});
