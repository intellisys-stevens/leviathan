import { describe, expect, it } from 'vitest';
import {
  formatBytesPerSecond,
  formatMetric,
  formatPercent,
  formatRoundedPercent,
  clampRenderedPercent,
  powerLevel,
  temperatureLevel,
} from './lib';
import type { Metric } from './types';

function metric(value: number | null, unit = 'celsius'): Metric {
  return {
    value,
    unit,
    source: 'nvml',
    scope: 'physical_gpu',
    sampledAt: '2026-08-29T12:00:00Z',
    status: value == null ? 'unsupported' : 'available',
  };
}

describe('detail chart formatting', () => {
  it('rounds utilization values and includes the percent unit', () => {
    expect(formatRoundedPercent(71.6)).toBe('72%');
    expect(formatRoundedPercent(0)).toBe('0%');
    expect(formatRoundedPercent(100)).toBe('100%');
    expect(formatRoundedPercent(89.99999999999996)).toBe('90%');
    expect(formatRoundedPercent(-Number.EPSILON)).toBe('0%');
    expect(formatPercent(-0)).toBe('0.0%');
    expect(formatPercent(-0.000_01)).toBe('0.0%');
    expect(clampRenderedPercent(-Number.EPSILON)).toBe(0);
    expect(clampRenderedPercent(100 + Number.EPSILON)).toBe(100);
  });
});

describe('physical metric presentation', () => {
  it('classifies GPU temperatures at stable thermal boundaries', () => {
    expect(temperatureLevel(metric(null))).toBe('unavailable');
    expect(temperatureLevel(metric(54.9))).toBe('cool');
    expect(temperatureLevel(metric(55))).toBe('normal');
    expect(temperatureLevel(metric(70))).toBe('warm');
    expect(temperatureLevel(metric(80))).toBe('hot');
  });

  it('classifies power relative to the reported device limit', () => {
    const limit = metric(400, 'watts');
    expect(powerLevel(metric(null, 'watts'), limit)).toBe('unavailable');
    expect(powerLevel(metric(100, 'watts'))).toBe('unknown');
    expect(powerLevel(metric(99, 'watts'), limit)).toBe('low');
    expect(powerLevel(metric(100, 'watts'), limit)).toBe('normal');
    expect(powerLevel(metric(240, 'watts'), limit)).toBe('high');
    expect(powerLevel(metric(340, 'watts'), limit)).toBe('near_limit');
  });

  it('formats canonical byte-per-second metrics with IEC units', () => {
    expect(formatBytesPerSecond(0)).toBe('0 B/s');
    expect(formatBytesPerSecond(1_073_741_824)).toBe('1.0 GiB/s');
    expect(formatBytesPerSecond(Number.NaN)).toBe('—');
    expect(formatMetric(metric(1_610_612_736, 'bytes_per_second'))).toBe(
      '1.5 GiB/s',
    );
  });
});
