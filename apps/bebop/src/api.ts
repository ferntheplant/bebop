export const bebopApiName = "bebop-api";

export function runBebopApi(): void {
  process.stdout.write(`${bebopApiName}\n`);
}

if (import.meta.main) {
  runBebopApi();
}
