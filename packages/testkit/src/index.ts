export * from "./postgres.ts";
export * from "./swordfish-control.ts";

export function createTestId(value: string): string {
  return `test-${value}`;
}
