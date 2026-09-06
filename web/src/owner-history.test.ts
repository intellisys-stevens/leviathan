import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  currentOwnerRow,
  mergeOwnerRows,
  ownerChartRows,
  parseOwnerHistory,
  useOwnerHistory,
} from './owner-history';
import { ownerFixture } from './test/owner-fixture';
import type { AlignedHistory } from './types';

function history(value = 2): AlignedHistory {
  return {
    window: '30m',
    series: [],
    points: [
      {
        sampledAt: '2026-09-05T11:59:00Z',
        values: {
          owner: {
            cpu_cores: value,
            memory_used_bytes: 2 ** 30,
            storage_read_bps: 0,
          },
        },
      },
      { sampledAt: '2026-09-05T11:59:02Z', values: {} },
      {
        sampledAt: '2026-09-05T11:59:04Z',
        values: { owner: { cpu_cores: value * 2 } },
      },
    ],
  };
}

describe('owner history', () => {
  it('preserves a completed longer window when a poll arrives during a failed shrink', async () => {
    let reject!: (reason: Error) => void;
    const old = history();
    old.points.unshift({
      sampledAt: '2026-09-05T11:40:00Z',
      values: { owner: { cpu_cores: 7 } },
    });
    const load = vi
      .fn()
      .mockResolvedValueOnce(old)
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      );
    const { result, rerender } = renderHook(
      ({ owner, windowMs }) =>
        useOwnerHistory(owner, load, windowMs, 12 * 3600000),
      { initialProps: { owner: ownerFixture(), windowMs: 30 * 60000 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ owner: ownerFixture(), windowMs: 15 * 60000 });
    rerender({
      owner: ownerFixture('owner-test', 'test-owner', '2026-09-05T12:00:02Z'),
      windowMs: 15 * 60000,
    });
    await act(async () => {
      reject(new Error('offline'));
    });
    expect(result.current.windowMs).toBe(30 * 60000);
    expect(result.current.rows[0].cpu_cores).toBe(7);
  });
  it('keeps measured zero, nulls unavailable and estimated values, and samples independently from GPU polling', () => {
    const owner = ownerFixture();
    owner.status = 'partial';
    owner.metrics.memory_used_bytes.status = 'estimated';
    const row = currentOwnerRow(owner)!;
    expect(row.storage_read_bps).toBe(0);
    expect(row.memory_used_bytes).toBeNull();
    expect(row.time).toBe(Date.parse(owner.sampledAt));
    expect(mergeOwnerRows([row], [row], 30 * 60000)).toHaveLength(1);
    owner.status = 'stale';
    expect(currentOwnerRow(owner)?.cpu_cores).toBeNull();
  });

  it('preserves explicit gaps and inserts a null break across reconnects without compressing timestamps', () => {
    const parsed = parseOwnerHistory(history());
    expect(parsed[1].cpu_cores).toBeNull();
    const later = { ...parsed[2], time: parsed[2].time + 100000 };
    const result = ownerChartRows([parsed[0], later], ['cpu_cores'], 5 * 60000);
    expect(result.rows.map((row) => row.cpu_cores)).toEqual([2, null, 4]);
    expect(result.domain[1] - result.domain[0]).toBe(5 * 60000);
    expect(result.rows.at(-1)!.time - result.rows[0].time).toBeGreaterThan(
      100000,
    );
  });

  it('loads all metrics in one independent owner request and retains history across retryable failure', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(history())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(history(3));
    const owner = ownerFixture();
    const { result, rerender } = renderHook(
      ({ windowMs }) => useOwnerHistory(owner, load, windowMs, 12 * 3600000),
      { initialProps: { windowMs: 30 * 60000 } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0].series).toEqual([
      {
        key: 'owner',
        entity: 'owner:owner-test',
        metrics: [
          'cpu_cores',
          'memory_used_bytes',
          'storage_read_bps',
          'storage_write_bps',
        ],
      },
    ]);
    const retained = result.current.rows;
    rerender({ windowMs: 15 * 60000 });
    await waitFor(() =>
      expect(result.current.error).toBe('History unavailable.'),
    );
    expect(result.current.rows).toEqual(retained);
    expect(result.current.windowMs).toBe(30 * 60000);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.rows[0].cpu_cores).toBe(3);
  });

  it('does not allow a late prior-owner response to replace current owner data', async () => {
    let release!: (value: AlignedHistory) => void;
    const pending = new Promise<AlignedHistory>((resolve) => {
      release = resolve;
    });
    const load = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(history(9));
    const { result, rerender } = renderHook(
      ({ owner }) => useOwnerHistory(owner, load, 30 * 60000, 12 * 3600000),
      { initialProps: { owner: ownerFixture() } },
    );
    rerender({ owner: ownerFixture('different-owner') });
    await waitFor(() => expect(result.current.rows[0].cpu_cores).toBe(9));
    await act(async () => {
      release(history(1));
      await pending;
    });
    expect(result.current.rows[0].cpu_cores).toBe(9);
  });

  it('does not mix a raw current sample into long-window aggregates', async () => {
    const load = vi.fn().mockResolvedValue(history());
    const owner = ownerFixture();
    const { result } = renderHook(() =>
      useOwnerHistory(owner, load, 4 * 3600000, 12 * 3600000),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toHaveLength(3);
    expect(
      result.current.rows.some(
        (row) => row.time === Date.parse(owner.sampledAt),
      ),
    ).toBe(false);
  });
});
