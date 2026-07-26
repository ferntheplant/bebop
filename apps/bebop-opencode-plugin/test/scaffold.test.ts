import { expect, test } from "vite-plus/test";

import { bebopPluginMetadata } from "#src/index.ts";

test("exports plugin metadata", () => {
  expect(bebopPluginMetadata).toEqual({ name: "bebop", version: 1 });
});
