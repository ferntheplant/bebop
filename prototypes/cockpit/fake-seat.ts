const [role = "ein", attempt = "1"] = process.argv.slice(2);

process.stdout.write(`PROTOTYPE ${role} seat, attempt ${attempt}\n`);
process.stdout.write("This pane stands in for the real OpenCode TUI.\n");

let tick = 0;
setInterval(() => {
  tick += 1;
  process.stdout.write(`${role} is still rendering (${tick})\n`);
}, 1_000);

process.stdin.resume();
