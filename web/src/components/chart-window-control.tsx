import { chartWindowPresets, formatDuration } from '../chart-window';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from './segmented-control';

type Props = {
  chartWindowMs: number;
  retentionMs: number;
  onChartWindowChange: (milliseconds: number) => void;
  ariaLabel?: string;
  className?: string;
};

export function ChartWindowControl({
  chartWindowMs,
  retentionMs,
  onChartWindowChange,
  ariaLabel = 'Chart window',
  className = '',
}: Props) {
  const customWindow = !chartWindowPresets.some(
    ({ milliseconds }) => milliseconds === chartWindowMs,
  );
  const options: SegmentedControlOption<number>[] = chartWindowPresets.map(
    ({ label, milliseconds }) => ({
      label,
      value: milliseconds,
      disabled: milliseconds > retentionMs,
    }),
  );
  if (customWindow) {
    options.push({
      value: chartWindowMs,
      label: formatDuration(chartWindowMs),
      ariaLabel: `Current custom window ${formatDuration(chartWindowMs)}`,
      disabled: true,
    });
  }

  return (
    <div
      className={`flex min-w-0 items-center gap-2 border-0 p-0 ${className}`}
    >
      <span className="font-mono text-[13px] uppercase tracking-[0.12em] text-muted-foreground">
        Window
      </span>
      <div className="chart-window-mobile sm:hidden">
        <select
          aria-label={ariaLabel}
          className="min-h-11 rounded-lg border border-border/80 bg-background/75 px-3 font-mono text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={String(chartWindowMs)}
          onChange={(event) => onChartWindowChange(Number(event.target.value))}
        >
          {options.map((option) => (
            <option
              key={option.value}
              value={String(option.value)}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="chart-window-desktop hidden sm:block">
        <SegmentedControl
          ariaLabel={ariaLabel}
          options={options}
          value={chartWindowMs}
          onValueChange={onChartWindowChange}
        />
      </div>
    </div>
  );
}
