// The artifact smoke for the packed `bebop-api`, `bebop-worker`, and `bebop` executables.
//
// Until this milestone the smoke could simply run each artifact and compare its stdout,
// because each one printed its own name and exited. They are real programs now: two of them
// want a database and stay up, and one is a CLI.
//
// What is still worth asserting is what a packaging mistake actually breaks — that each
// bundle **loads and reaches its own code**. A missing dependency, a dynamic import that did
// not survive bundling, or a platform module that only resolves from source all fail here,
// and none of them are visible from a type check.
//
// Reaching its own code is proved by the specific complaint each artifact makes: the servers
// report a configuration error, and the CLI prints its usage.

import { spawn } from "bun";

const distributionDirectory = new URL("../dist/", import.meta.url).pathname;

interface Probe {
  readonly name: string;
  readonly artifact: string;
  readonly args: ReadonlyArray<string>;
  /** Environment for the run. Empty `BEBOP_*` values are what force the configuration error. */
  readonly env: Readonly<Record<string, string>>;
  readonly expectExitCode: "zero" | "nonzero";
  readonly expectOutput: string;
}

const probes: ReadonlyArray<Probe> = [
  {
    name: "bebop-api",
    artifact: "api.mjs",
    args: [],
    env: { BEBOP_HOST: "", BEBOP_PORT: "", BEBOP_DATABASE_URL: "" },
    expectExitCode: "nonzero",
    expectOutput: "ConfigError",
  },
  {
    name: "bebop-worker",
    artifact: "worker.mjs",
    args: [],
    env: { BEBOP_HOST: "", BEBOP_PORT: "", BEBOP_DATABASE_URL: "" },
    expectExitCode: "nonzero",
    expectOutput: "ConfigError",
  },
  {
    name: "bebop",
    artifact: "cli.mjs",
    args: ["--help"],
    env: {},
    expectExitCode: "zero",
    // `prototypes/effect-runtime` finding 4: without a `Stdio` layer the CLI fails at startup for
    // every invocation including `--help`, so printing usage proves the platform layer
    // survived packing.
    expectOutput: "USAGE",
  },
];

let failures = 0;

for (const probe of probes) {
  const child = spawn(["bun", `${distributionDirectory}${probe.artifact}`, ...probe.args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...probe.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}${stderr}`;
  const exitCodeMatches = probe.expectExitCode === "zero" ? exitCode === 0 : exitCode !== 0;
  const outputMatches = output.includes(probe.expectOutput);

  if (exitCodeMatches && outputMatches) {
    process.stdout.write(`  PASS  ${probe.name} (${probe.artifact})\n`);
    continue;
  }
  failures += 1;
  process.stdout.write(
    `  FAIL  ${probe.name} (${probe.artifact})\n` +
      `        expected ${probe.expectExitCode} exit and output containing ${JSON.stringify(probe.expectOutput)}\n` +
      `        got exit ${exitCode}: ${output.slice(0, 400).trim()}\n`,
  );
}

process.stdout.write(`\n${probes.length - failures}/${probes.length} artifacts started\n`);
if (failures > 0) {
  process.exitCode = 1;
}
