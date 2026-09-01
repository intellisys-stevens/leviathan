import { useMediaQuery } from './use-media-query';

export const chartTooltipMediaQuery =
  '(min-width: 768px) and (hover: hover) and (pointer: fine)';

export function useChartTooltips(): boolean {
  return useMediaQuery(chartTooltipMediaQuery, true);
}
