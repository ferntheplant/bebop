import { expect, test } from "vite-plus/test";

import { swordfishCliName } from "#src/cli.ts";
import { swordfishDaemonName } from "#src/daemon.ts";

test("exposes the swordfish process entrypoints", () => {
  expect([swordfishDaemonName, swordfishCliName]).toEqual(["swordfish", "sf"]);
});
