import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/daemon.ts", "src/cli.ts"],
    format: ["esm"],
    sourcemap: true,
  },
  run: {
    tasks: {
      smoke: {
        command: "bun scripts/smoke.ts",
        dependsOn: ["build", { task: "build", from: ["dependencies", "devDependencies"] }],
      },
    },
  },
});
