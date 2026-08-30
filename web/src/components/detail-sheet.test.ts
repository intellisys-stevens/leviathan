import { describe, expect, it } from 'vitest';
import type { HistorySeries } from '../types';
import { appendHistoryPoint } from './detail-sheet';

describe('detail history accumulation', () => {
  it('incrementally retains live points, replaces duplicates, and trims by time', () => {
    const initial: HistorySeries = {
      entity: 'GPU-a',
      metrics: ['gpu_activity'],
      window: '30m0s',
      points: [
        {
          sampledAt: '2026-08-29T11:59:58Z',
          values: { gpu_activity: 10 },
        },
      ],
    };
    const second = appendHistoryPoint(
      initial,
      {
        sampledAt: '2026-08-29T11:59:59Z',
        values: { gpu_activity: 20 },
      },
      5_000,
    );
    const third = appendHistoryPoint(
      second,
      {
        sampledAt: '2026-08-29T12:00:00Z',
        values: { gpu_activity: 30 },
      },
      5_000,
    );
    const replaced = appendHistoryPoint(
      third,
      {
        sampledAt: '2026-08-29T12:00:00Z',
        values: { gpu_activity: 31 },
      },
      5_000,
    );

    expect(replaced.points.map(({ values }) => values.gpu_activity)).toEqual([
      10, 20, 31,
    ]);
    expect(replaced.points.every((point) => 'time' in point)).toBe(true);

    const trimmed = appendHistoryPoint(
      replaced,
      {
        sampledAt: '2026-08-29T12:00:06Z',
        values: { gpu_activity: 40 },
      },
      5_000,
    );
    expect(trimmed.points).toHaveLength(1);
    expect(trimmed.points[0].values.gpu_activity).toBe(40);
  });
});
