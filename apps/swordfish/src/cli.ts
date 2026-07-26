#!/usr/bin/env bun

export const swordfishCliName = "sf";

export function runSwordfishCli(): void {
  process.stdout.write(`${swordfishCliName}\n`);
}

if (import.meta.main) {
  runSwordfishCli();
}
