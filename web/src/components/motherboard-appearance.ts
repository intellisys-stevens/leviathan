import type { Metric, Snapshot } from '../types';

export type MotherboardCategoryId = 'cpu' | 'memory' | 'storage';

/** Utilization percentages, never inferred physical DIMMs or storage devices. */
export type MotherboardAppearance = {
  cpu: number | null;
  memory: number | null;
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

/** Transport freshness comes from the accepted-snapshot connection state. */
export function buildMotherboardAppearance(
  snapshot: Snapshot | null,
  live: boolean,
): MotherboardAppearance {
  const system = live ? snapshot?.system : undefined;
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
  };
}

export function motherboardGlowIntensity(utilization: number | null): number {
  return utilization != null && Number.isFinite(utilization)
    ? 0.15 + 0.65 * (Math.max(0, Math.min(100, utilization)) / 100)
    : 0;
}
