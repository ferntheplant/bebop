#!/usr/bin/env bun

export const swordfishDaemonName = "swordfish";

export function runSwordfishDaemon(): void {
  process.stdout.write(`${swordfishDaemonName}\n`);
}

if (import.meta.main) {
  runSwordfishDaemon();
}
