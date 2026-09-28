import { describe, expect, it } from 'vitest';
import { orderedCapacityRows, parseGPUCapacity } from './gpu-capacity';

const row = {
  id: 'native-80',
  mode: 'native',
  model: 'Synthetic GPU',
  memoryBytes: 80 * 1024 ** 3,
  available: 0,
  status: 'available',
};
const snapshot = {
  status: 'available',
  observedAt: '2026-09-06T12:00:00Z',
  revision: 1,
  rows: [row],
};

describe('GPU capacity response validation', () => {
  it('keeps an observed zero distinct from unknown capacity', () => {
    expect(parseGPUCapacity(snapshot).rows[0].available).toBe(0);
    expect(
      parseGPUCapacity({
        ...snapshot,
        status: 'partial',
        rows: [{ ...row, status: 'unavailable', available: null }],
      }).rows[0].available,
    ).toBeNull();
  });

  it.each([
    { ...snapshot, observedAt: undefined },
    { ...snapshot, revision: -1 },
    { ...snapshot, observedAt: 'yesterday' },
    { ...snapshot, rows: [row, row] },
    ...[-1, 1.5, null, undefined, '4', Number.MAX_SAFE_INTEGER + 1].map(
      (available) => ({ ...snapshot, rows: [{ ...row, available }] }),
    ),
    { ...snapshot, rows: [{ ...row, memoryBytes: -1 }] },
  ])('rejects invalid or ambiguous available counts %#', (value) => {
    expect(() => parseGPUCapacity(value)).toThrow();
  });

  it('accepts an unavailable service with no observation or fabricated rows', () => {
    expect(
      parseGPUCapacity({ status: 'unavailable', revision: 0, rows: [] }).rows,
    ).toEqual([]);
  });

  it('orders actual profiles without combining their alternative counts', () => {
    const data = parseGPUCapacity({
      ...snapshot,
      rows: [
        {
          ...row,
          id: 'mig-20',
          mode: 'mig',
          profile: '1g.20gb',
          memoryBytes: 20 * 1024 ** 3,
          available: 8,
        },
        {
          ...row,
          id: 'mig-40',
          mode: 'mig',
          profile: '2g.40gb',
          memoryBytes: 40 * 1024 ** 3,
          available: 4,
        },
        { ...row, available: 2 },
      ],
    });
    expect(
      orderedCapacityRows(data.rows).map(({ available }) => available),
    ).toEqual([2, 4, 8]);
    expect(data.rows[0].id).toBe('mig-20');
  });
});
