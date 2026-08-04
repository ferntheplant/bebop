import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      prototype: {
        command: "bun run.ts",
        cache: false,
        dependsOn: ["@bebop/server#build", "@bebop/swordfish#build"],
      },
    },
  },
});
