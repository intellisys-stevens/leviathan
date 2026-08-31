import { chartWindowPresets, formatDuration } from '../chart-window';

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

  return (
    <fieldset
      className={`flex min-w-0 items-center gap-2 border-0 p-0 ${className}`}
      aria-label={ariaLabel}
    >
      <legend className="float-left font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground">
        Window
      </legend>
      <div className="flex rounded-md border border-input bg-popover p-0.5 shadow-sm">
        {chartWindowPresets.map(({ label, milliseconds }) => (
          <button
            key={label}
            type="button"
            className={`h-6 rounded px-2 font-mono text-[9px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 ${
              chartWindowMs === milliseconds
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
            disabled={milliseconds > retentionMs}
            aria-pressed={chartWindowMs === milliseconds}
            onClick={() => onChartWindowChange(milliseconds)}
          >
            {label}
          </button>
        ))}
        {customWindow ? (
          <span className="flex h-6 items-center rounded bg-background px-2 font-mono text-[9px] text-foreground shadow-sm">
            {formatDuration(chartWindowMs)}
          </span>
        ) : null}
      </div>
    </fieldset>
  );
}
