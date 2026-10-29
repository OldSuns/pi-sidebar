const trimZero = (text: string) => text.replace(/\.0$/, "");

/** 940, 76.4k, 200k, 1.2M (R-8). */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${trimZero((value / 1000).toFixed(1))}k`;
  return `${trimZero((value / 1_000_000).toFixed(1))}M`;
}

export function formatCost(value: number): string {
  return `$${value.toFixed(3)}`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** 12ms, 4.2s, 1m12s, 1h5m. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${trimZero((ms / 1000).toFixed(1))}s`;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m${seconds % 60}s`;
}

/** Coarse age for "idle 2m": <1m, minutes, hours, days. The idle clock ticks every 30 seconds. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 > 0 ? `${hours}h${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 > 0 ? `${days}d${hours % 24}h` : `${days}d`;
}

/** Running clock, 0:42 or 1:02:03. */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
