export const bebopWorkerName = "bebop-worker";

export function runBebopWorker(): void {
  process.stdout.write(`${bebopWorkerName}\n`);
}

if (import.meta.main) {
  runBebopWorker();
}
