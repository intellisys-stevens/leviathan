import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  trendCeilingContractionDelayMilliseconds,
  useTrendCeiling,
} from './use-trend-ceiling';

afterEach(() => vi.useRealTimers());

describe('trend ceiling hysteresis', () => {
  it('expands immediately and contracts only after 30s below half-scale', () => {
    vi.useFakeTimers();
    const view = renderHook(({ maximum }) => useTrendCeiling(maximum), {
      initialProps: { maximum: 91 },
    });
    expect(view.result.current).toBe(200);

    view.rerender({ maximum: 410 });
    expect(view.result.current).toBe(500);
    void act(() => vi.advanceTimersByTime(0));

    view.rerender({ maximum: 250 });
    void act(() =>
      vi.advanceTimersByTime(trendCeilingContractionDelayMilliseconds),
    );
    expect(view.result.current).toBe(500);

    view.rerender({ maximum: 180 });
    expect(view.result.current).toBe(500);
    void act(() =>
      vi.advanceTimersByTime(trendCeilingContractionDelayMilliseconds - 1),
    );
    expect(view.result.current).toBe(500);
    void act(() => vi.advanceTimersByTime(1));
    expect(view.result.current).toBe(200);
  });

  it('cancels a pending contraction when the target expands again', () => {
    vi.useFakeTimers();
    const view = renderHook(({ maximum }) => useTrendCeiling(maximum), {
      initialProps: { maximum: 410 },
    });

    view.rerender({ maximum: 40 });
    void act(() =>
      vi.advanceTimersByTime(trendCeilingContractionDelayMilliseconds / 2),
    );
    view.rerender({ maximum: 910 });
    expect(view.result.current).toBe(2_000);
    void act(() =>
      vi.advanceTimersByTime(trendCeilingContractionDelayMilliseconds),
    );
    expect(view.result.current).toBe(2_000);
  });
});
