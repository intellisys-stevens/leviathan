import { describe, expect, it } from 'vitest';
import {
  chipLayout,
  gpuChipActivity,
  gpuChipRegions,
  gpuTopologyKey,
} from './gpu-chip';
import type { GPU, Metric } from '../types';
function fixture(): GPU {
  const memory = {
    totalBytes: 100,
    usedBytes: 40,
    freeBytes: 60,
    status: 'available' as const,
    source: 'synthetic' as const,
    scope: 'gpu_instance' as const,
    sampledAt: '2026-09-05T00:00:00Z',
  };
  return {
    uuid: 'gpu',
    index: 0,
    name: 'Test',
    migEnabled: true,
    maxMigDevices: 7,
    memory,
    metrics: {},
    gpuInstances: [3, 1].map((id) => ({
      uuid: `gi-${id}`,
      id,
      profile: '2g.24gb',
      generation: `gi-${id}@1`,
      memory,
      metrics: {},
      computeInstances: [1, 0].map((ci) => ({
        uuid: `ci-${id}-${ci}`,
        id: ci,
        profile: '1c.2g.24gb',
        generation: `ci-${id}-${ci}@1`,
        memory,
        metrics: {},
      })),
    })),
  };
}
describe('observed chip regions', () => {
  it('makes four quadrants for four compute instances', () => {
    expect(chipLayout(4)).toEqual([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ]);
  });
  it.each([1, 2, 3, 5, 6, 7, 8, 13, 32])(
    'covers the chip equally without invented slots for %i instances',
    (count) => {
      const cells = chipLayout(count);
      expect(cells).toHaveLength(count);
      expect(
        cells.reduce((sum, cell) => sum + cell.width * cell.height, 0),
      ).toBeCloseTo(1);
      for (const [index, cell] of cells.entries()) {
        expect(cell.width * cell.height).toBeCloseTo(1 / count);
        expect(cell.x + cell.width).toBeLessThanOrEqual(1.0000001);
        expect(cell.y + cell.height).toBeLessThanOrEqual(1.0000001);
        for (const other of cells.slice(index + 1)) {
          const overlapX =
            Math.min(cell.x + cell.width, other.x + other.width) -
            Math.max(cell.x, other.x);
          const overlapY =
            Math.min(cell.y + cell.height, other.y + other.height) -
            Math.max(cell.y, other.y);
          expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(0.0000001);
        }
      }
    },
  );
  it('sorts without mutation, deduplicates CIs, and retains shared GI telemetry', () => {
    const gpu = fixture();
    gpu.gpuInstances[0].computeInstances.push(
      gpu.gpuInstances[0].computeInstances[0],
    );
    const regions = gpuChipRegions(gpu);
    expect(regions.map((region) => region.label)).toEqual([
      'GI 1 · CI 0',
      'GI 1 · CI 1',
      'GI 3 · CI 0',
      'GI 3 · CI 1',
    ]);
    expect(gpu.gpuInstances.map((gi) => gi.id)).toEqual([3, 1]);
    const first = regions[0].selection,
      second = regions[1].selection;
    if (first.kind !== 'compute_instance' || second.kind !== 'compute_instance')
      throw new Error('CI expected');
    expect(first.gi).toBe(second.gi);
    expect(first.gi.memory).toBe(gpu.gpuInstances[1].memory);
  });
  it('keeps empty MIG empty, including GIs without CIs', () => {
    const gpu = fixture();
    for (const gi of gpu.gpuInstances) gi.computeInstances = [];
    expect(gpuChipRegions(gpu)).toEqual([]);
    gpu.gpuInstances = [];
    expect(gpuChipRegions(gpu)).toEqual([]);
    gpu.migEnabled = false;
    expect(gpuChipRegions(gpu)).toHaveLength(1);
    expect(gpuChipRegions(gpu)[0].selection.kind).toBe('physical_gpu');
  });
  it('changes identity for topology, not polling or ordering', () => {
    const gpu = fixture();
    const before = gpuTopologyKey(gpu);
    gpu.memory.usedBytes = (gpu.memory.usedBytes ?? 0) + 1;
    gpu.gpuInstances.reverse();
    gpu.gpuInstances[0].computeInstances.reverse();
    expect(gpuTopologyKey(gpu)).toBe(before);
    gpu.gpuInstances[0].computeInstances[0].generation += '-new';
    expect(gpuTopologyKey(gpu)).not.toBe(before);
  });
});

describe('chip activity provenance', () => {
  function metric(
    value: number | null,
    overrides: Partial<Metric> = {},
  ): Metric {
    return {
      value,
      unit: 'percent',
      source: 'nvml_gpm',
      scope: 'gpu_instance',
      sampledAt: '2026-09-05T00:00:00Z',
      status: 'available',
      ...overrides,
    };
  }

  it('uses the same GI SM measurement for sibling CIs and ignores their memory or metrics', () => {
    const gpu = fixture();
    gpu.gpuInstances[1].metrics.sm_activity = metric(67.5);
    gpu.gpuInstances[1].computeInstances[0].metrics.sm_activity = metric(99, {
      scope: 'compute_instance',
    });
    const regions = gpuChipRegions(gpu);
    expect(regions.map((region) => gpuChipActivity(region))).toEqual([
      67.5,
      67.5,
      null,
      null,
    ]);
  });

  it('uses physical SM for a full GPU and preserves measured zero', () => {
    const gpu = fixture();
    gpu.migEnabled = false;
    gpu.metrics.sm_activity = metric(0, { scope: 'physical_gpu' });
    gpu.metrics.gpu_activity = metric(100, { scope: 'physical_gpu' });
    const [region] = gpuChipRegions(gpu);
    expect(gpuChipActivity(region)).toBe(0);
    expect(gpuChipActivity(region, false)).toBeNull();
    gpu.metrics.sm_activity.value = 42;
    expect(gpuChipActivity(region)).toBe(42);
  });

  it.each<Partial<Metric>>([
    { status: 'stale' },
    { status: 'estimated' },
    { status: 'error' },
    { status: 'unsupported' },
    { status: 'permission_denied' },
    { value: null },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: -1 },
    { value: 101 },
    { unit: 'watts' },
    { scope: 'compute_instance' },
  ])('rejects unavailable or invalid activity: %j', (override) => {
    const gpu = fixture();
    gpu.gpuInstances[1].metrics.sm_activity = metric(55, override);
    expect(gpuChipActivity(gpuChipRegions(gpu)[0])).toBeNull();
  });
});
