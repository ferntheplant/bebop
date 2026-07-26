import { expect, test } from "vite-plus/test";

import { bebopProtocolVersion } from "#src/index.ts";

test("exports the initial protocol marker", () => {
  expect(bebopProtocolVersion).toBe(1);
});
