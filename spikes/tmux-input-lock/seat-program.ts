// Stands in for an OpenCode seat TUI inside the pane under test.
//
// It does the two things the spike needs to distinguish: it produces output continuously,
// so "is output hidden?" is answerable by watching the pane, and it records everything
// that reaches its stdin, so "did that keystroke get through?" is answerable by a file on
// disk rather than by reading a terminal snapshot.
//
// The sentinel file is the load-bearing measurement. A pane can look unchanged while the
// program behind it has already consumed the input.

import { appendFileSync, writeFileSync } from "node:fs";

const logPath = process.argv[2];

if (logPath === undefined) {
  throw new Error("usage: seat-program.ts <input-log-path>");
}

writeFileSync(logPath, "");

let tick = 0;
setInterval(() => {
  tick += 1;
  process.stdout.write(`tick ${tick}\n`);
}, 250);

for await (const line of console) {
  appendFileSync(logPath, `${line}\n`);
  process.stdout.write(`INPUT ${line}\n`);
}
