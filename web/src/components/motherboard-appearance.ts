import type { Metric, Snapshot } from '../types';

export type MotherboardCategoryId = 'cpu' | 'memory' | 'storage';

/** Measured host activity; storage throughput is bytes/s, never disk-busy percent. */
export type MotherboardAppearance = {
  cpu: number | null;
  memory: number | null;
  storageBytesPerSecond: number | null;
};

export const MOTHERBOARD_COLORS = {
  dark: { accent: '#35cee4', outline: '#a1eef7', pcb: '#10282e' },
  light: { accent: '#087f96', outline: '#006477', pcb: '#193239' },
} as const;

function measuredUtilization(metric: Metric | undefined): number | null {
  if (
    metric?.status !== 'available' ||
    metric.scope !== 'host' ||
    metric.unit !== 'percent' ||
    metric.value == null ||
    !Number.isFinite(metric.value) ||
    metric.value < 0 ||
    metric.value > 100
  )
    return null;
  return metric.value;
}

function measuredRate(metric: Metric | undefined): number | null {
  return metric?.status === 'available' &&
    metric.scope === 'host' &&
    metric.unit === 'bytes_per_second' &&
    metric.value != null &&
    Number.isFinite(metric.value) &&
    metric.value >= 0
    ? metric.value
    : null;
}

/** Transport freshness comes from the accepted-snapshot connection state. */
export function buildMotherboardAppearance(
  snapshot: Snapshot | null,
  live: boolean,
): MotherboardAppearance {
  const system = live ? snapshot?.system : undefined;
  const read = measuredRate(system?.storage?.readBytesPerSecond);
  const write = measuredRate(system?.storage?.writeBytesPerSecond);
  return {
    cpu:
      // The CPU summary can be stale solely because load-average collection failed.
      // Utilization has its own status; retained utilization is marked stale too.
      system?.cpu &&
      (system.cpu.status === 'available' || system.cpu.status === 'stale')
        ? measuredUtilization(system.cpu.utilization)
        : null,
    memory:
      system?.memory?.status === 'available'
        ? measuredUtilization(system.memory.utilization)
        : null,
    // Rates have independent freshness, even when a filesystem capacity read fails.
    storageBytesPerSecond:
      read != null && write != null && Number.isFinite(read + write)
        ? read + write
        : null,
  };
}

/** Cosmetic log scale: 1 MiB/s is subtle; 1 GiB/s reaches the visual ceiling. */
export function storageActivityIntensity(
  bytesPerSecond: number | null,
): number {
  return bytesPerSecond != null &&
    Number.isFinite(bytesPerSecond) &&
    bytesPerSecond > 0
    ? Math.min(1, Math.log1p(bytesPerSecond / 1024 ** 2) / Math.log1p(1024))
    : 0;
}

export function motherboardGlowIntensity(utilization: number | null): number {
  return utilization != null && Number.isFinite(utilization)
    ? 0.15 + 0.65 * (Math.max(0, Math.min(100, utilization)) / 100)
    : 0;
}
