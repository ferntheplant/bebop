import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    sourcemap: true,
  },
  run: {
    tasks: {
      smoke: {
        command: "bun -e 'await import(\"@bebop/opencode-plugin\")'",
        dependsOn: ["build", { task: "build", from: ["dependencies", "devDependencies"] }],
      },
    },
  },
});
