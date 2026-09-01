import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { chartRows, overviewMetricValue } from './components/overview-charts';
import {
  buildOverviewEntities,
  mergeOverviewPoints,
  overviewTopologyKey,
  pointFromSnapshot,
  useOverviewHistory,
  type OverviewPoint,
} from './overview-history';
import type { AlignedHistory, Snapshot } from './types';

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
          gpu_activity: {
            value: 37,
            unit: 'percent',
            source: 'nvml',
            scope: 'physical_gpu',
            sampledAt,
            status: 'available',
          },
          memory_activity: {
            value: 22,
            unit: 'percent',
            source: 'nvml',
            scope: 'physical_gpu',
            sampledAt,
            status: 'available',
          },
          pcie_rx_bytes_per_second: {
            value: 1_073_741_824,
            unit: 'bytes_per_second',
            source: 'nvml',
            scope: 'physical_gpu',
            sampledAt,
            status: 'available',
          },
          pcie_tx_bytes_per_second: {
            value: 536_870_912,
            unit: 'bytes_per_second',
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
                value: 0,
                unit: 'percent',
                source: 'nvml_gpm',
                scope: 'gpu_instance',
                sampledAt,
                status: 'available',
              },
              sm_activity: {
                value: 65,
                unit: 'percent',
                source: 'nvml_gpm',
                scope: 'gpu_instance',
                sampledAt,
                status: 'available',
              },
              dram_activity: {
                value: 41,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('overview history', () => {
  it('uses stable physical and generation-aware GI entities', () => {
    const snapshot = fixture();
    const entities = buildOverviewEntities(snapshot);
    expect(entities.map(({ label, scope }) => ({ label, scope }))).toEqual([
      { label: 'GPU 0', scope: 'physical_gpu' },
      { label: 'GPU 0 · GI 3', scope: 'gpu_instance' },
    ]);
    expect(entities.map(({ colorIndex }) => colorIndex)).toEqual([0, 1]);
    const key = overviewTopologyKey(snapshot);
    snapshot.gpus[0].gpuInstances[0].generation = 'GPU-a/gi/3@g3';
    expect(overviewTopologyKey(snapshot)).not.toBe(key);
  });

  it('uses SM activity for GI utilization and device activity for full GPUs', () => {
    const snapshot = fixture();
    const [gpu, gi] = buildOverviewEntities(snapshot);
    const point = pointFromSnapshot(snapshot, gi);
    expect(point?.values).toEqual({
      gpu_activity: 0,
      sm_activity: 65,
      dram_activity: 41,
      memory_used_bytes: 20,
      memory_total_bytes: 80,
    });
    expect(point && overviewMetricValue(point, 'utilization', gi.scope)).toBe(
      65,
    );
    expect(
      point && overviewMetricValue(point, 'memory_activity', gi.scope),
    ).toBe(41);
    expect(
      point && overviewMetricValue(point, 'memory_percent', gi.scope),
    ).toBe(25);

    const gpuPoint = pointFromSnapshot(snapshot, gpu);
    expect(
      gpuPoint && overviewMetricValue(gpuPoint, 'utilization', gpu.scope),
    ).toBe(37);
    expect(
      gpuPoint && overviewMetricValue(gpuPoint, 'memory_activity', gpu.scope),
    ).toBe(22);

    const data = chartRows(
      [gi],
      { [gi.key]: point ? [point] : [] },
      'utilization',
    );
    expect(data.rows[0].series_0).toBe(65);
    expect(data.availableSeries).toBe(1);
  });

  it('turns unavailable samples into chart gaps', () => {
    const gi = buildOverviewEntities(fixture())[1];
    const data = chartRows(
      [gi],
      { [gi.key]: [{ sampledAt, values: {} }] },
      'utilization',
    );
    expect(data.rows[0].series_0).toBeNull();
    expect(data.availableSeries).toBe(0);
  });

  it('uses an exact PCIe total and retains its directional components', () => {
    const gpu = buildOverviewEntities(fixture())[0];
    const first: OverviewPoint = {
      sampledAt: '2026-08-29T11:59:59Z',
      values: {
        pcie_rx_bytes_per_second: 1,
        pcie_tx_bytes_per_second: 2,
      },
    };
    const second: OverviewPoint = {
      sampledAt,
      values: {
        pcie_rx_bytes_per_second: 3,
        pcie_tx_bytes_per_second: 4,
      },
    };

    expect(overviewMetricValue(first, 'pcie_total', 'physical_gpu')).toBe(3);
    expect(
      overviewMetricValue(
        {
          ...first,
          values: { pcie_rx_bytes_per_second: 1 },
        },
        'pcie_total',
        'physical_gpu',
      ),
    ).toBeNull();

    const data = chartRows([gpu], { [gpu.key]: [first, second] }, 'pcie_total');
    expect(data.rows[0]).toMatchObject({
      series_0: 3,
      series_0_rx: 1,
      series_0_tx: 2,
    });
    expect(data.rows[1]).toMatchObject({
      series_0: 7,
      series_0_rx: 3,
      series_0_tx: 4,
    });
  });

  it('renders stable five-second buckets without mutating raw points', () => {
    const gi = buildOverviewEntities(fixture())[1];
    const values = [10, 20, 30, 40, 50, 60];
    const points = values.map((value, index) => ({
      sampledAt: `2026-08-29T11:59:${String(index).padStart(2, '0')}Z`,
      values: { sm_activity: value },
    }));
    const data = chartRows([gi], { [gi.key]: points }, 'utilization');

    expect(data.rows.map((row) => row.series_0)).toEqual([30, 60]);
    expect(points.map((point) => point.values.sm_activity)).toEqual(values);
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
    ).toEqual([{ ...incoming, time: Date.parse(incoming.sampledAt) }]);
  });

  it('keeps live samples received during aligned loads and ignores stale range responses', async () => {
    const initial = fixture();
    const entity = buildOverviewEntities(initial)[1];
    const descriptor = {
      key: entity.key,
      entity: entity.uuid,
      metrics: ['sm_activity'],
    };
    const entities = [entity];
    const descriptors = [descriptor];
    const first = deferred<AlignedHistory>();
    const second = deferred<AlignedHistory>();
    const loadHistory = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const hook = renderHook(
      ({ snapshot, windowMilliseconds }) =>
        useOverviewHistory(
          snapshot,
          'utilization-chart',
          entities,
          descriptors,
          loadHistory,
          windowMilliseconds,
          60 * 60 * 1000,
        ),
      {
        initialProps: {
          snapshot: initial,
          windowMilliseconds: 30 * 60 * 1000,
        },
      },
    );
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));

    const live = structuredClone(initial);
    live.sequence = 2;
    live.sampledAt = '2026-08-29T12:00:01Z';
    live.gpus[0].gpuInstances[0].metrics.sm_activity.value = 88;
    hook.rerender({ snapshot: live, windowMilliseconds: 30 * 60 * 1000 });
    hook.rerender({ snapshot: live, windowMilliseconds: 5 * 60 * 1000 });
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.resolve({
        window: '30m0s',
        series: [descriptor],
        points: [
          {
            sampledAt: '2026-08-29T11:59:58Z',
            values: { [entity.key]: { sm_activity: 1 } },
          },
        ],
      });
      await first.promise;
    });
    expect(
      hook.result.current.points[entity.key]?.some(
        (point) => point.values.sm_activity === 1,
      ),
    ).toBe(false);

    await act(async () => {
      second.resolve({
        window: '5m0s',
        series: [descriptor],
        points: [
          {
            sampledAt: '2026-08-29T11:59:58Z',
            values: { [entity.key]: { sm_activity: 20 } },
          },
          {
            sampledAt,
            values: { [entity.key]: { sm_activity: 65 } },
          },
        ],
      });
      await second.promise;
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(
      hook.result.current.points[entity.key]?.map(
        (point) => point.values.sm_activity,
      ),
    ).toEqual([20, 65, 88]);
  });

  it('keeps compact long-window plots unchanged between aggregate boundaries', async () => {
    const initial = fixture();
    const entity = buildOverviewEntities(initial)[1];
    const descriptor = {
      key: entity.key,
      entity: entity.uuid,
      metrics: ['sm_activity'],
    };
    const loadHistory = vi.fn().mockResolvedValue({
      window: '4h0m0s',
      series: [descriptor],
      points: [
        {
          sampledAt: '2026-08-29T11:59:30Z',
          values: { [entity.key]: { sm_activity: 20 } },
        },
      ],
    });
    const hook = renderHook(
      ({ snapshot }) =>
        useOverviewHistory(
          snapshot,
          'utilization-chart',
          [entity],
          [descriptor],
          loadHistory,
          4 * 60 * 60 * 1000,
          12 * 60 * 60 * 1000,
        ),
      { initialProps: { snapshot: initial } },
    );

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(
      hook.result.current.points[entity.key]?.map(
        (point) => point.values.sm_activity,
      ),
    ).toEqual([20]);

    const live = structuredClone(initial);
    live.sequence = 2;
    live.sampledAt = '2026-08-29T12:00:01Z';
    live.gpus[0].gpuInstances[0].metrics.sm_activity.value = 88;
    hook.rerender({ snapshot: live });

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(
      hook.result.current.points[entity.key]?.map(
        (point) => point.values.sm_activity,
      ),
    ).toEqual([20]);
  });

  it('records only the current resolved window and preserves loaded points on failure', async () => {
    const current = fixture();
    const entity = buildOverviewEntities(current)[1];
    const descriptor = {
      key: entity.key,
      entity: entity.uuid,
      metrics: ['sm_activity'],
    };
    const entities = [entity];
    const descriptors = [descriptor];
    const first = deferred<AlignedHistory>();
    const stale = deferred<AlignedHistory>();
    const failed = deferred<AlignedHistory>();
    const retry = deferred<AlignedHistory>();
    const loadHistory = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    const hook = renderHook(
      ({ windowMilliseconds }) =>
        useOverviewHistory(
          current,
          'utilization-chart',
          entities,
          descriptors,
          loadHistory,
          windowMilliseconds,
          60 * 60 * 1000,
        ),
      { initialProps: { windowMilliseconds: 30 * 60 * 1000 } },
    );
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.loadedWindowMilliseconds).toBeNull();

    await act(async () => {
      first.resolve({
        window: '30m0s',
        series: descriptors,
        points: [
          {
            sampledAt: '2026-08-29T11:59:58Z',
            values: { [entity.key]: { sm_activity: 33 } },
          },
        ],
      });
      await first.promise;
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.loadedWindowMilliseconds).toBe(30 * 60 * 1000);
    const retainedValues = hook.result.current.points[entity.key]?.map(
      (point) => point.values.sm_activity,
    );
    expect(retainedValues).toEqual([33, 65]);

    hook.rerender({ windowMilliseconds: 5 * 60 * 1000 });
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.loadedWindowMilliseconds).toBe(30 * 60 * 1000);
    expect(
      hook.result.current.points[entity.key]?.map(
        (point) => point.values.sm_activity,
      ),
    ).toEqual(retainedValues);

    hook.rerender({ windowMilliseconds: 15 * 60 * 1000 });
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(3));
    await act(async () => {
      stale.resolve({
        window: '5m0s',
        series: descriptors,
        points: [
          {
            sampledAt: '2026-08-29T11:59:59Z',
            values: { [entity.key]: { sm_activity: 999 } },
          },
        ],
      });
      await stale.promise;
    });
    expect(hook.result.current.loadedWindowMilliseconds).toBe(30 * 60 * 1000);
    expect(
      hook.result.current.points[entity.key]?.map(
        (point) => point.values.sm_activity,
      ),
    ).toEqual(retainedValues);

    await act(async () => {
      failed.reject(new Error('offline'));
      await failed.promise.catch(() => undefined);
    });
    await waitFor(() =>
      expect(hook.result.current.error).toBe('History request failed.'),
    );
    expect(hook.result.current.loadedWindowMilliseconds).toBe(30 * 60 * 1000);
    expect(
      hook.result.current.points[entity.key]?.map(
        (point) => point.values.sm_activity,
      ),
    ).toEqual(retainedValues);

    act(() => hook.result.current.retry());
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(4));
    await act(async () => {
      retry.resolve({
        window: '15m0s',
        series: descriptors,
        points: [
          {
            sampledAt: '2026-08-29T11:59:58Z',
            values: { [entity.key]: { sm_activity: 55 } },
          },
        ],
      });
      await retry.promise;
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.loadedWindowMilliseconds).toBe(15 * 60 * 1000);
    expect(
      hook.result.current.points[entity.key]?.map(
        (point) => point.values.sm_activity,
      ),
    ).toEqual([55, 65]);
  });

  it('clears the request latch and retries failed aligned history locally', async () => {
    const current = fixture();
    const entity = buildOverviewEntities(current)[1];
    const descriptor = {
      key: entity.key,
      entity: entity.uuid,
      metrics: ['sm_activity'],
    };
    const entities = [entity];
    const descriptors = [descriptor];
    const loadHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        window: '30m0s',
        series: [descriptor],
        points: [],
      });
    const hook = renderHook(() =>
      useOverviewHistory(
        current,
        'utilization-chart',
        entities,
        descriptors,
        loadHistory,
        30 * 60 * 1000,
        60 * 60 * 1000,
      ),
    );

    await waitFor(() =>
      expect(hook.result.current.error).toBe('History request failed.'),
    );
    expect(loadHistory).toHaveBeenCalledTimes(1);

    act(() => hook.result.current.retry());
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.error).toBeNull());
  });
});
