// Spawning a process and reading everything it wrote before it exited.
//
// The idiom is `Bun.spawn`, then `Promise.all` over `new Response(child.stdout).text()`,
// `new Response(child.stderr).text()`, and `child.exited`. Two smoke scripts — and several
// prototype drivers before them — had written it by hand; the second real consumer is when the
// code moves to a package (Code moves to a package on its second consumer (ADR 0007)).
//
// The helper returns the collected result and lets the caller decide what a nonzero exit
// means. A nonzero exit is an expected outcome for the callers here — the smoke scripts assert
// exit codes and output rather than failing on them — so this never throws over the process
// result.

export type SpawnAndCollectOptions = Omit<
  Bun.SpawnOptions.SpawnOptions<"pipe", "pipe", "pipe">,
  "stdin" | "stdout" | "stderr" | "stdio" | "lazy" | "terminal"
> & {
  /**
   * Content written to the child's stdin before it is closed. Passing a string gives the child
   * a pipe on stdin; passing nothing leaves Bun's default (`"ignore"`).
   */
  readonly stdin?: string;
};

export interface SpawnAndCollectResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function spawnAndCollect(
  command: readonly string[],
  options: SpawnAndCollectOptions = {},
): Promise<SpawnAndCollectResult> {
  const { stdin, ...spawnOptions } = options;
  const child = Bun.spawn<"pipe", "pipe", "pipe">([...command], {
    ...spawnOptions,
    stdout: "pipe",
    stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin: "pipe" }),
  });
  if (stdin !== undefined) {
    void child.stdin.write(stdin);
    void child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
