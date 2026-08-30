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
    case 'bytes_per_second':
    case 'bytes/second':
      return formatBytesPerSecond(value);
    default:
      return `${value.toFixed(2)} ${metric?.unit ?? ''}`.trim();
  }
}

export type TemperatureLevel =
  | 'unavailable'
  | 'cool'
  | 'normal'
  | 'warm'
  | 'hot';

export type PowerLevel =
  | 'unavailable'
  | 'unknown'
  | 'low'
  | 'normal'
  | 'high'
  | 'near_limit';

export function temperatureLevel(metric?: Metric): TemperatureLevel {
  const value = metricValue(metric);
  if (value == null) return 'unavailable';
  if (value < 55) return 'cool';
  if (value < 70) return 'normal';
  if (value < 80) return 'warm';
  return 'hot';
}

export function powerLevel(power?: Metric, limit?: Metric): PowerLevel {
  const powerValue = metricValue(power);
  if (powerValue == null) return 'unavailable';
  const limitValue = metricValue(limit);
  if (limitValue == null || limitValue <= 0) return 'unknown';
  const ratio = powerValue / limitValue;
  if (ratio < 0.25) return 'low';
  if (ratio < 0.6) return 'normal';
  if (ratio < 0.85) return 'high';
  return 'near_limit';
}

export function formatBytesPerSecond(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  let current = Math.max(0, value);
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
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
