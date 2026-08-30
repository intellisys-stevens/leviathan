export const chartWindowStorageKey = 'miglens.chartWindow.v1';
export const detailChartWindowStorageKey = 'miglens.detailChartWindow.v1';
export const defaultChartWindowMs = 30 * 60 * 1000;
export const defaultHistoryWindowMs = 60 * 60 * 1000;

export const chartWindowPresets = [
  { label: '5m', milliseconds: 5 * 60 * 1000 },
  { label: '15m', milliseconds: 15 * 60 * 1000 },
  { label: '30m', milliseconds: defaultChartWindowMs },
  { label: '1h', milliseconds: 60 * 60 * 1000 },
] as const;

function storedWindow(key: string): number {
  const value = Number(localStorage.getItem(key));
  return chartWindowPresets.some(({ milliseconds }) => milliseconds === value)
    ? value
    : defaultChartWindowMs;
}

export function storedChartWindow(): number {
  return storedWindow(chartWindowStorageKey);
}

export function storedDetailChartWindow(): number {
  return storedWindow(detailChartWindowStorageKey);
}

export function effectiveChartWindow(
  requestedMilliseconds: number,
  retentionMilliseconds: number,
): number {
  if (requestedMilliseconds <= retentionMilliseconds)
    return requestedMilliseconds;
  const available = chartWindowPresets.filter(
    ({ milliseconds }) => milliseconds <= retentionMilliseconds,
  );
  return available.at(-1)?.milliseconds ?? Math.max(1, retentionMilliseconds);
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds >= 60 * 60 * 1000 && milliseconds % (60 * 60 * 1000) === 0)
    return `${milliseconds / (60 * 60 * 1000)}h`;
  if (milliseconds >= 60 * 1000 && milliseconds % (60 * 1000) === 0)
    return `${milliseconds / (60 * 1000)}m`;
  if (milliseconds >= 1000 && milliseconds % 1000 === 0)
    return `${milliseconds / 1000}s`;
  return `${Number((milliseconds / 1000).toFixed(2))}s`;
}

export function durationQuery(milliseconds: number): string {
  const preset = chartWindowPresets.find(
    (candidate) => candidate.milliseconds === milliseconds,
  );
  return preset?.label ?? `${Math.max(1, Math.round(milliseconds))}ms`;
}

export function formatSamplingInterval(milliseconds: number): string {
  return `${Number((milliseconds / 1000).toFixed(2))}s`;
}
