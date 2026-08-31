import type { ChartRow } from './overview-history';

export type TrendStatistic = 'count' | 'latest' | 'maximum' | 'minimum';

export type TrendValueSummary = {
  count: number;
  latest: number | null;
  maximum: number | null;
  minimum: number | null;
  partial: boolean;
  trend: number | null;
};

const fiveMinutes = 5 * 60 * 1000;
const fifteenMinutes = 15 * 60 * 1000;
const thirtyMinutes = 30 * 60 * 1000;

export function trendBucketMilliseconds(windowMilliseconds: number): number {
  if (windowMilliseconds <= fiveMinutes) return 1_000;
  if (windowMilliseconds <= fifteenMinutes) return 3_000;
  if (windowMilliseconds <= thirtyMinutes) return 5_000;
  return 10_000;
}

export function trendStatisticKey(
  valueKey: string,
  statistic: TrendStatistic,
): string {
  return `${valueKey}__trend_${statistic}`;
}

export function trendPartialKey(valueKey: string): string {
  return `${valueKey}__trend_partial`;
}

type Accumulator = {
  count: number;
  gap: boolean;
  latest: number | null;
  maximum: number | null;
  minimum: number | null;
  sum: number;
};

function accumulator(): Accumulator {
  return {
    count: 0,
    gap: false,
    latest: null,
    maximum: null,
    minimum: null,
    sum: 0,
  };
}

export function buildTrendRows(
  rows: readonly ChartRow[],
  valueKeys: readonly string[],
  windowMilliseconds: number,
): ChartRow[] {
  if (rows.length === 0 || valueKeys.length === 0) return [];
  const bucketMilliseconds = trendBucketMilliseconds(windowMilliseconds);
  const ordered = rows.toSorted((left, right) => left.time - right.time);
  const latestTime = ordered.at(-1)?.time ?? 0;
  const buckets = new Map<number, { values: Map<string, Accumulator> }>();

  for (const row of ordered) {
    if (!Number.isFinite(row.time)) continue;
    const bucketEnd =
      Math.floor(row.time / bucketMilliseconds) * bucketMilliseconds +
      bucketMilliseconds;
    let bucket = buckets.get(bucketEnd);
    if (!bucket) {
      bucket = { values: new Map() };
      buckets.set(bucketEnd, bucket);
    }
    for (const key of valueKeys) {
      let value = bucket.values.get(key);
      if (!value) {
        value = accumulator();
        bucket.values.set(key, value);
      }
      const sample = row[key];
      if (typeof sample !== 'number' || !Number.isFinite(sample)) {
        value.gap = true;
        continue;
      }
      value.count += 1;
      value.sum += sample;
      value.latest = sample;
      value.minimum =
        value.minimum == null ? sample : Math.min(value.minimum, sample);
      value.maximum =
        value.maximum == null ? sample : Math.max(value.maximum, sample);
    }
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([time, bucket]) => {
      const row: ChartRow = { time };
      for (const key of valueKeys) {
        const value = bucket.values.get(key) ?? accumulator();
        row[key] =
          value.count > 0 && !value.gap ? value.sum / value.count : null;
        row[trendStatisticKey(key, 'count')] = value.count;
        row[trendStatisticKey(key, 'latest')] = value.latest;
        row[trendStatisticKey(key, 'minimum')] = value.minimum;
        row[trendStatisticKey(key, 'maximum')] = value.maximum;
        row[trendPartialKey(key)] = time > latestTime ? 1 : 0;
      }
      return row;
    });
}

export function trendValueSummary(
  row: ChartRow | undefined,
  valueKey: string,
): TrendValueSummary {
  const numberOrNull = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    count: numberOrNull(row?.[trendStatisticKey(valueKey, 'count')]) ?? 0,
    latest: numberOrNull(row?.[trendStatisticKey(valueKey, 'latest')]),
    maximum: numberOrNull(row?.[trendStatisticKey(valueKey, 'maximum')]),
    minimum: numberOrNull(row?.[trendStatisticKey(valueKey, 'minimum')]),
    partial: row?.[trendPartialKey(valueKey)] === 1,
    trend: numberOrNull(row?.[valueKey]),
  };
}

export function trendTimeDomain(
  latestTime: number,
  windowMilliseconds: number,
): readonly [number, number] {
  const bucketMilliseconds = trendBucketMilliseconds(windowMilliseconds);
  const end =
    Math.floor(latestTime / bucketMilliseconds) * bucketMilliseconds +
    bucketMilliseconds;
  return [end - windowMilliseconds, end] as const;
}

export function niceTrendCeiling(maximum: number): number {
  if (!Number.isFinite(maximum) || maximum <= 0) return 1;
  const target = maximum * 1.1;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const step =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}
