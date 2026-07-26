import { expect, test } from "vite-plus/test";

import { createTestId } from "#src/index.ts";

test("creates deterministic test identifiers", () => {
  expect(createTestId("bounty")).toBe("test-bounty");
});
