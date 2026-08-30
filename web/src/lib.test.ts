import { describe, expect, it } from 'vitest';
import { formatRoundedPercent } from './lib';

describe('detail chart formatting', () => {
  it('rounds utilization values and includes the percent unit', () => {
    expect(formatRoundedPercent(71.6)).toBe('72%');
    expect(formatRoundedPercent(0)).toBe('0%');
    expect(formatRoundedPercent(100)).toBe('100%');
  });
});
