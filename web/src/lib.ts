import type { Memory, Metric, Process } from './types';

export function metricValue(metric?: Metric): number | null {
  return metric?.status === 'available' && metric.value != null
    ? metric.value
    : null;
}

export function formatMetric(metric?: Metric): string {
  const value = metricValue(metric);
  if (value == null) return '—';
  switch (metric?.unit) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'celsius':
      return `${Math.round(value)}°C`;
    case 'watts':
      return `${Math.round(value)} W`;
    case 'mhz':
      return `${Math.round(value)} MHz`;
    default:
      return `${value.toFixed(2)} ${metric?.unit ?? ''}`.trim();
  }
}

export function formatRoundedPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

export function memoryPercent(memory: Memory): number | null {
  if (
    memory.status !== 'available' ||
    memory.usedBytes == null ||
    !memory.totalBytes
  )
    return null;
  return Math.max(
    0,
    Math.min(100, (memory.usedBytes / memory.totalBytes) * 100),
  );
}

export function shortUUID(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, 12)}…${value.slice(-7)}`;
}

export function processSearchText(process: Process): string {
  return [process.pid, process.user, process.executable]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
