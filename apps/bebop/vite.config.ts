import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/api.ts", "src/worker.ts", "src/cli.ts"],
    format: ["esm"],
    sourcemap: true,
  },
});
