export * from "./postgres.ts";

export function createTestId(value: string): string {
  return `test-${value}`;
}
