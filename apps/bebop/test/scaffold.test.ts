import { expect, test } from "vite-plus/test";

import { bebopApiName } from "#src/api.ts";
import { bebopCliName } from "#src/cli.ts";
import { bebopWorkerName } from "#src/worker.ts";

test("exposes the bebop process entrypoints", () => {
  expect([bebopApiName, bebopWorkerName, bebopCliName]).toEqual(["bebop-api", "bebop-worker", "bebop"]);
});
