import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  historyRefreshMilliseconds,
  nextHistoryRefreshDelay,
  useHistoryRefreshGeneration,
} from './use-history-refresh';

describe('long history refresh cadence', () => {
  it('refreshes only aggregate-backed windows at their bucket boundaries', () => {
    expect(historyRefreshMilliseconds(60 * 60_000)).toBeNull();
    expect(historyRefreshMilliseconds(4 * 60 * 60_000)).toBe(30_000);
    expect(historyRefreshMilliseconds(12 * 60 * 60_000)).toBe(120_000);
    expect(nextHistoryRefreshDelay(31_000, 4 * 60 * 60_000)).toBe(29_025);
  });

  it('increments after the next boundary and continues at the bucket cadence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(31_000);
    const view = renderHook(() => useHistoryRefreshGeneration(4 * 60 * 60_000));
    expect(view.result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(29_024);
    });
    expect(view.result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(view.result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(view.result.current).toBe(2);
    vi.useRealTimers();
  });
});
