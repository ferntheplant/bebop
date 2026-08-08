import { expect, test } from "vite-plus/test";

import { spawnAndCollect } from "#src/index.ts";

test("collects stdout, stderr, and the exit code", async () => {
  const result = await spawnAndCollect([
    "bun",
    "-e",
    "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exitCode = 3",
  ]);
  expect(result.stdout.trim()).toBe("out");
  expect(result.stderr.trim()).toBe("err");
  expect(result.exitCode).toBe(3);
});

test("writes stdin before the child reads it", async () => {
  const result = await spawnAndCollect(
    [
      "bun",
      "-e",
      "let input = ''; process.stdin.on('data', (chunk) => (input += chunk)).on('end', () => console.log(input.trim()))",
    ],
    { stdin: "hello" },
  );
  expect(result.stdout.trim()).toBe("hello");
  expect(result.exitCode).toBe(0);
});
