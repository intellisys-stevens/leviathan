import { useEffect, useState } from 'react';
import { niceTrendCeiling } from './chart-trend';

export const trendCeilingContractionDelayMilliseconds = 30_000;

export function useTrendCeiling(maximum: number): number {
  const target = niceTrendCeiling(maximum);
  const [settled, setSettled] = useState(target);
  const belowHalf = target < settled && maximum < settled / 2;

  useEffect(() => {
    if (target === settled) return;
    if (target < settled && !belowHalf) return;
    const timer = setTimeout(
      () => setSettled(target),
      target > settled ? 0 : trendCeilingContractionDelayMilliseconds,
    );
    return () => clearTimeout(timer);
  }, [belowHalf, settled, target]);

  // A larger sample must never clip while React waits to run the effect.
  return Math.max(settled, target);
}
