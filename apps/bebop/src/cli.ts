#!/usr/bin/env bun

export const bebopCliName = "bebop";

export function runBebopCli(): void {
  process.stdout.write(`${bebopCliName}\n`);
}

if (import.meta.main) {
  runBebopCli();
}
