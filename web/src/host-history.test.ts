import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  currentHostPoints,
  hostChartRows,
  hostHistoryDescriptors,
  mergeHostPoints,
  parseHostHistory,
  useHostHistory,
} from './host-history';
import type { AlignedHistory, Snapshot } from './types';
import { systemFixture } from './test/system-fixture';

const sampledAt = '2026-09-05T12:00:00Z';
function snapshot(): Snapshot {
  return { sampledAt, system: systemFixture(sampledAt) } as Snapshot;
}
function history(): AlignedHistory {
  return {
    window: '30m',
    series: hostHistoryDescriptors,
    points: [
      {
        sampledAt: '2026-09-05T11:59:40Z',
        values: {
          cpu: { cpu_utilization: 20 },
          memory: { memory_utilization: 40 },
          storage: { storage_used_bytes: 3, storage_total_bytes: 10 },
          read: { disk_read_bytes_per_second: 10 },
        },
      },
      { sampledAt: '2026-09-05T11:59:45Z', values: {} },
      {
        sampledAt: '2026-09-05T11:59:50Z',
        values: {
          cpu: { cpu_utilization: 50 },
          read: { disk_read_bytes_per_second: 20 },
          write: { disk_write_bytes_per_second: 30 },
        },
      },
    ],
  };
}

describe('host history', () => {
  it('uses metric/domain timestamps and does not invent GPU-cadence host samples', () => {
    const initial = snapshot();
    initial.system.cpu.utilization.sampledAt = '2026-09-05T11:59:59Z';
    const first = currentHostPoints(initial);
    const next = currentHostPoints({
      ...initial,
      sampledAt: '2026-09-05T12:00:05Z',
    });
    expect(first.cpu[0].sampledAt).toBe('2026-09-05T11:59:59Z');
    expect(mergeHostPoints(first, next, 30 * 60_000).cpu).toHaveLength(1);
  });

  it('preserves missing samples and real byte-rate units', () => {
    const points = parseHostHistory(history());
    expect(points.cpu[1].values).toEqual({});
    expect(points.storage[0].values.value).toBe(30);
    expect(points.read[0].values.value).toBe(10);
    expect(points.write[0].values).toEqual({});
    const { rows } = hostChartRows(points, ['cpu'], 30 * 60_000);
    expect(rows.map((row) => row.cpu)).toEqual([20, null, 50]);
  });

  it('withholds stale current values and supports estimated RAM', () => {
    const data = snapshot();
    data.system.cpu.utilization.status = 'stale';
    data.system.memory.utilization.status = 'estimated';
    data.system.storage.status = 'stale';
    const points = currentHostPoints(data);
    expect(points.cpu[0].values).toEqual({});
    expect(points.storage[0].values).toEqual({});
    expect(points.memory[0].values.value).toBeCloseTo(40.625);
  });

  it('retains history on failure and retries one shared aligned request', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(history())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(history());
    const data = snapshot();
    const { result, rerender } = renderHook(
      ({ windowMs }) => useHostHistory(data, load, windowMs, 12 * 3600_000),
      { initialProps: { windowMs: 30 * 60_000 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0].series).toEqual(hostHistoryDescriptors);
    const first = result.current.points.cpu;
    rerender({ windowMs: 15 * 60_000 });
    await waitFor(() =>
      expect(result.current.error).toBe('History unavailable.'),
    );
    expect(result.current.points.cpu).toEqual(first);
    expect(result.current.windowMs).toBe(30 * 60_000);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(load).toHaveBeenCalledTimes(3);
    expect(result.current.windowMs).toBe(15 * 60_000);
  });

  it('ignores an older request completing after the selected range changed', async () => {
    let release: (response: AlignedHistory) => void = () => {};
    const pending = new Promise<AlignedHistory>((resolve) => {
      release = resolve;
    });
    const newer = history();
    newer.points[0].values.cpu.cpu_utilization = 88;
    const load = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(newer);
    const data = snapshot();
    const { result, rerender } = renderHook(
      ({ windowMs }) => useHostHistory(data, load, windowMs, 12 * 3600_000),
      { initialProps: { windowMs: 30 * 60_000 } },
    );
    rerender({ windowMs: 15 * 60_000 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      release(history());
      await pending;
    });
    expect(result.current.points.cpu[0].values.value).toBe(88);
    expect(result.current.windowMs).toBe(15 * 60_000);
  });

  it('does not mix raw current samples into long-window aggregates', async () => {
    const load = vi.fn().mockResolvedValue(history());
    const data = snapshot();
    const { result } = renderHook(() =>
      useHostHistory(data, load, 4 * 3600_000, 12 * 3600_000),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.points.cpu).toHaveLength(3);
    expect(
      result.current.points.cpu.some((point) => point.sampledAt === sampledAt),
    ).toBe(false);
  });

  it('keeps retained aggregates unchanged when loading a shorter range fails', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(history())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(history());
    const data = snapshot();
    const { result, rerender } = renderHook(
      ({ snapshot, windowMs }) =>
        useHostHistory(snapshot, load, windowMs, 12 * 3600_000),
      { initialProps: { snapshot: data, windowMs: 4 * 3600_000 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const aggregates = result.current.points.cpu;
    rerender({ snapshot: data, windowMs: 30 * 60_000 });
    await waitFor(() =>
      expect(result.current.error).toBe('History unavailable.'),
    );
    const later = {
      sampledAt: '2026-09-05T12:00:01Z',
      system: systemFixture('2026-09-05T12:00:01Z'),
    } as Snapshot;
    later.system.cpu.utilization.value = 88;
    rerender({ snapshot: later, windowMs: 30 * 60_000 });
    expect(result.current.windowMs).toBe(4 * 3600_000);
    expect(result.current.points.cpu).toEqual(aggregates);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.windowMs).toBe(30 * 60_000));
    expect(result.current.points.cpu.at(-1)?.values.value).toBe(88);
  });
});
