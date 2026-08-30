import { describe, expect, it } from 'vitest';
import { chartRows, overviewMetricValue } from './components/overview-charts';
import {
  buildOverviewEntities,
  downsampleChartRows,
  mergeOverviewPoints,
  movingAverageChartRows,
  overviewTopologyKey,
  pointFromSnapshot,
  type ChartRow,
} from './overview-history';
import type { Snapshot } from './types';

const sampledAt = '2026-08-29T12:00:00Z';

function fixture(): Snapshot {
  return {
    schemaVersion: 'v1',
    sequence: 1,
    sampledAt,
    host: { hostname: 'fixture', os: 'linux', arch: 'amd64' },
    processes: [],
    diagnostics: [],
    capabilities: {
      nvml: { name: 'NVML', available: true, status: 'available' },
      gpm: { name: 'GPM', available: true, status: 'available' },
      dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
      proc: { name: '/proc GPU clients', available: true, status: 'available' },
      profileMetrics: true,
    },
    gpus: [
      {
        uuid: 'GPU-a',
        index: 0,
        name: 'Fixture GPU',
        migEnabled: true,
        maxMigDevices: 1,
        memory: {
          totalBytes: 100,
          usedBytes: 40,
          freeBytes: 60,
          source: 'nvml',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        metrics: {
          temperature: {
            value: 48,
            unit: 'celsius',
            source: 'nvml',
            scope: 'physical_gpu',
            sampledAt,
            status: 'available',
          },
        },
        gpuInstances: [
          {
            uuid: 'GPU-a/gi/3',
            id: 3,
            profile: '1g.24gb',
            generation: 'GPU-a/gi/3@g2',
            memory: {
              totalBytes: 80,
              usedBytes: 20,
              freeBytes: 60,
              source: 'nvml',
              scope: 'gpu_instance',
              sampledAt,
              status: 'available',
            },
            metrics: {
              gpu_activity: {
                value: null,
                unit: 'percent',
                source: 'nvml_gpm',
                scope: 'gpu_instance',
                sampledAt,
                status: 'stale',
              },
              sm_activity: {
                value: 65,
                unit: 'percent',
                source: 'nvml_gpm',
                scope: 'gpu_instance',
                sampledAt,
                status: 'available',
              },
            },
            computeInstances: [],
          },
        ],
      },
    ],
  };
}

describe('overview history', () => {
  it('uses stable physical and generation-aware GI entities', () => {
    const snapshot = fixture();
    const entities = buildOverviewEntities(snapshot);
    expect(entities.map(({ label, scope }) => ({ label, scope }))).toEqual([
      { label: 'GPU 0', scope: 'physical_gpu' },
      { label: 'GPU 0 · GI 3', scope: 'gpu_instance' },
    ]);
    const key = overviewTopologyKey(snapshot);
    snapshot.gpus[0].gpuInstances[0].generation = 'GPU-a/gi/3@g3';
    expect(overviewTopologyKey(snapshot)).not.toBe(key);
  });

  it('turns unavailable samples into gaps and converts memory to percent', () => {
    const snapshot = fixture();
    const gi = buildOverviewEntities(snapshot)[1];
    const point = pointFromSnapshot(snapshot, gi);
    expect(point?.values).toEqual({
      sm_activity: 65,
      memory_used_bytes: 20,
      memory_total_bytes: 80,
    });
    expect(point && overviewMetricValue(point, 'gpu_activity')).toBeNull();
    expect(point && overviewMetricValue(point, 'memory_percent')).toBe(25);
    const data = chartRows(
      [gi],
      { [gi.key]: point ? [point] : [] },
      'gpu_activity',
    );
    expect(data.rows[0].series_0).toBeNull();
    expect(data.availableSeries).toBe(0);
  });

  it('renders a five-second trailing average without mutating raw points', () => {
    const gi = buildOverviewEntities(fixture())[1];
    const values = [10, 20, 30, 40, 50, 60];
    const points = values.map((value, index) => ({
      sampledAt: `2026-08-29T11:59:${String(index).padStart(2, '0')}Z`,
      values: { sm_activity: value },
    }));
    const data = chartRows([gi], { [gi.key]: points }, 'sm_activity');

    expect(data.rows.map((row) => row.series_0)).toEqual([
      10, 15, 20, 25, 30, 40,
    ]);
    expect(points.map((point) => point.values.sm_activity)).toEqual(values);
  });

  it('uses the same five-second window at every offered sampling rate', () => {
    const expectation = [
      { interval: 500, count: 11, expected: 6.5 },
      { interval: 1000, count: 6, expected: 4 },
      { interval: 2000, count: 4, expected: 3 },
    ];
    for (const { interval, count, expected } of expectation) {
      const rows: ChartRow[] = Array.from({ length: count }, (_, index) => ({
        time: index * interval,
        value: index + 1,
      }));
      expect(movingAverageChartRows(rows, ['value']).at(-1)?.value).toBe(
        expected,
      );
      expect(rows.at(-1)?.value).toBe(count);
    }
  });

  it('keeps missing samples as gaps and restarts averaging after each gap', () => {
    const rows: ChartRow[] = [
      { time: 1, value: 10 },
      { time: 2, value: 20 },
      { time: 3, value: null },
      { time: 4, value: 40 },
      { time: 5, value: 60 },
    ];

    expect(
      movingAverageChartRows(rows, ['value']).map((row) => row.value),
    ).toEqual([10, 15, null, 40, 50]);
    expect(rows[2].value).toBeNull();
  });

  it('deduplicates timestamps, prefers incoming points, and bounds the window', () => {
    const old = { sampledAt: '2026-08-29T11:29:59Z', values: { value: 1 } };
    const duplicate = {
      sampledAt: '2026-08-29T11:59:00Z',
      values: { value: 2 },
    };
    const incoming = { ...duplicate, values: { value: 3 } };
    expect(
      mergeOverviewPoints(
        [old, duplicate],
        [incoming],
        sampledAt,
        30 * 60 * 1000,
      ),
    ).toEqual([incoming]);
  });

  it('preserves every series minimum and maximum in each downsample bucket', () => {
    const rows: ChartRow[] = Array.from({ length: 1_000 }, (_, time) => ({
      time,
      a: time === 150 ? 999 : time === 170 ? -999 : time % 20,
      b: time === 550 ? 777 : time === 570 ? -777 : time % 11,
    }));
    const sampled = downsampleChartRows(rows, ['a', 'b'], 10);
    expect(sampled.length).toBeLessThan(rows.length);
    expect(sampled).toContain(rows[150]);
    expect(sampled).toContain(rows[170]);
    expect(sampled).toContain(rows[550]);
    expect(sampled).toContain(rows[570]);
    expect(sampled[0]).toBe(rows[0]);
    expect(sampled.at(-1)).toBe(rows.at(-1));
  });
});
