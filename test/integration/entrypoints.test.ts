import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vite-plus/test";

const executeFile = promisify(execFile);

const entrypoints = [
  ["Bebop API", "apps/bebop/src/api.ts", "bebop-api"],
  ["Bebop worker", "apps/bebop/src/worker.ts", "bebop-worker"],
  ["Bebop CLI", "apps/bebop/src/cli.ts", "bebop"],
  ["Swordfish daemon", "apps/swordfish/src/daemon.ts", "swordfish"],
  ["Swordfish CLI", "apps/swordfish/src/cli.ts", "sf"],
] as const;

test("starts every process entrypoint", async () => {
  for (const [_name, entrypoint, expectedOutput] of entrypoints) {
    const { stderr, stdout } = await executeFile("bun", [entrypoint]);

    expect(stderr).toBe("");
    expect(stdout).toBe(`${expectedOutput}\n`);
  }
});
