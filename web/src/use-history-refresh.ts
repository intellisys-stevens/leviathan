import { useEffect, useState } from 'react';
import { trendBucketMilliseconds } from './chart-trend';

export const rawHistoryWindowMilliseconds = 60 * 60 * 1000;

export function historyRefreshMilliseconds(
  windowMilliseconds: number,
): number | null {
  return windowMilliseconds > rawHistoryWindowMilliseconds
    ? trendBucketMilliseconds(windowMilliseconds)
    : null;
}

export function nextHistoryRefreshDelay(
  now: number,
  windowMilliseconds: number,
): number | null {
  const interval = historyRefreshMilliseconds(windowMilliseconds);
  if (interval == null) return null;
  return interval - (now % interval) + 25;
}

// Long-window curves are backed by server-side aggregates. Refreshing on the
// next epoch boundary finalizes the previous bucket without polling at the
// source sampling cadence.
export function useHistoryRefreshGeneration(
  windowMilliseconds: number,
): number {
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const delay = nextHistoryRefreshDelay(Date.now(), windowMilliseconds);
    if (delay == null) return;
    let intervalID: ReturnType<typeof setInterval> | null = null;
    const timeoutID = setTimeout(() => {
      setGeneration((value) => value + 1);
      const interval = historyRefreshMilliseconds(windowMilliseconds);
      if (interval != null) {
        intervalID = setInterval(
          () => setGeneration((value) => value + 1),
          interval,
        );
      }
    }, delay);
    return () => {
      clearTimeout(timeoutID);
      if (intervalID != null) clearInterval(intervalID);
    };
  }, [windowMilliseconds]);

  return generation;
}
