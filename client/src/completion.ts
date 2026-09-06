export function formatCompletionTime(elapsedTicks: number, tickRate: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedTicks / Math.max(1, tickRate)));
  return `${Math.floor(totalSeconds / 60).toString().padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}
