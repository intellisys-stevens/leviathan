import { describe, expect, it } from 'vitest';
import {
  buildTrendRows,
  niceTrendCeiling,
  trendBucketMilliseconds,
  trendTimeDomain,
  trendValueSummary,
} from './chart-trend';
import type { ChartRow } from './overview-history';

describe('stable chart trends', () => {
  it('uses deterministic bucket sizes for every supported window', () => {
    expect(trendBucketMilliseconds(5 * 60_000)).toBe(1_000);
    expect(trendBucketMilliseconds(15 * 60_000)).toBe(3_000);
    expect(trendBucketMilliseconds(30 * 60_000)).toBe(5_000);
    expect(trendBucketMilliseconds(60 * 60_000)).toBe(10_000);
    expect(trendBucketMilliseconds(4 * 60 * 60_000)).toBe(30_000);
    expect(trendBucketMilliseconds(12 * 60 * 60_000)).toBe(2 * 60_000);
  });

  it('keeps closed buckets immutable while only the latest bucket changes', () => {
    const rows: ChartRow[] = [
      { time: 1_000, value: 10 },
      { time: 2_000, value: 20 },
      { time: 6_000, value: 30 },
    ];
    const first = buildTrendRows(rows, ['value'], 30 * 60_000);
    const next = buildTrendRows(
      [...rows, { time: 7_000, value: 50 }],
      ['value'],
      30 * 60_000,
    );

    expect(first[0]).toEqual(next[0]);
    expect(first[1].value).toBe(30);
    expect(next[1].value).toBe(40);
    expect(trendValueSummary(next[1], 'value')).toEqual({
      count: 2,
      latest: 50,
      maximum: 50,
      minimum: 30,
      partial: true,
      trend: 40,
    });
  });

  it('preserves explicit gaps instead of averaging across them', () => {
    const trend = buildTrendRows(
      [
        { time: 1_000, value: 10 },
        { time: 2_000, value: null },
        { time: 6_000, value: 30 },
      ],
      ['value'],
      30 * 60_000,
    );
    expect(trend.map((row) => row.value)).toEqual([null, 30]);
  });

  it('anchors time to epoch buckets and quantizes dynamic ceilings', () => {
    expect(trendTimeDomain(31_001, 30 * 60_000)).toEqual([-1_765_000, 35_000]);
    expect(niceTrendCeiling(0)).toBe(1);
    expect(niceTrendCeiling(91)).toBe(200);
    expect(niceTrendCeiling(1_610_612_736)).toBe(2_000_000_000);
  });
});
