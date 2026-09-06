import { useId, useMemo, useState, type HTMLAttributes } from 'react';
import type { ChartRow } from '../overview-history';
import './compact-charts.css';

export type CompactChartUnit = '%' | 'percent' | '°C' | 'bytes_per_second';

/** Presentation only: preserve source precision in the history and tooltips. */
export function compactChartValue(
  value: number | null | undefined,
  unit: CompactChartUnit,
): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (unit === 'bytes_per_second') {
    if (value <= 0) return '0 B/s';
    const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
    let scaled = value;
    let index = 0;
    while (scaled >= 1024 && index < units.length - 1) {
      scaled /= 1024;
      index += 1;
    }
    // Do not round a value below the next unit into a four-digit label.
    if (scaled >= 999.5 && index < units.length - 1) {
      scaled /= 1024;
      index += 1;
    }
    return `${Number(scaled.toPrecision(3))} ${units[index]}`;
  }
  if (unit === '°C') return `${Math.round(value)}°C`;
  if (value > 0 && value < 0.1) return '<0.1%';
  return `${Number(value.toFixed(1))}%`;
}

export function nearestChartSample(
  rows: readonly ChartRow[],
  time: number,
): number {
  if (!rows.length) return -1;
  let left = 0;
  let right = rows.length;
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (rows[middle].time < time) left = middle + 1;
    else right = middle;
  }
  if (left === 0) return 0;
  if (left === rows.length) return rows.length - 1;
  return time - rows[left - 1].time <= rows[left].time - time ? left - 1 : left;
}

export function useChartSelection(
  rows: readonly ChartRow[],
  domain: readonly [number, number],
  scope: string,
) {
  const id = useId();
  const samples = useMemo(
    () => rows.filter((row) => Number.isFinite(row.time)),
    [rows],
  );
  const [selected, setSelected] = useState<{
    scope: string;
    time: number;
  } | null>(null);
  const time = selected?.scope === scope ? selected.time : null;
  const index = time == null ? -1 : nearestChartSample(samples, time);
  const selectedRow = index < 0 ? null : samples[index];
  const select = (next: number) => {
    const row = samples[Math.min(samples.length - 1, Math.max(0, next))];
    if (row) setSelected({ scope, time: row.time });
  };
  const reset = () => setSelected(null);
  const plotProps: HTMLAttributes<HTMLElement> = {
    id: `${id}-plot`,
    tabIndex: samples.length ? 0 : undefined,
    'aria-describedby': `${id}-help${selectedRow ? ` ${id}-readout` : ''}`,
    'aria-keyshortcuts': 'ArrowLeft ArrowRight Home End Escape',
    onKeyDown(event) {
      // Nested retry buttons and Recharts' own focus targets keep their keys.
      if (event.target !== event.currentTarget) return;
      let next: number;
      if (event.key === 'Escape') {
        if (selectedRow) {
          event.preventDefault();
          event.stopPropagation();
          reset();
        }
        return;
      }
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = samples.length - 1;
      else if (event.key === 'ArrowLeft')
        next = (index < 0 ? samples.length - 1 : index) - 1;
      else if (event.key === 'ArrowRight')
        next = index < 0 ? samples.length - 1 : index + 1;
      else return;
      event.preventDefault();
      event.stopPropagation();
      select(next);
    },
    onClick(event) {
      if ((event.target as Element).closest('button, a, input')) return;
      const grid = event.currentTarget.querySelector(
        '.recharts-cartesian-grid-horizontal line',
      );
      const rect =
        grid?.getBoundingClientRect() ??
        event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const fraction = Math.min(
        1,
        Math.max(0, (event.clientX - rect.left) / rect.width),
      );
      select(
        nearestChartSample(
          samples,
          domain[0] + fraction * (domain[1] - domain[0]),
        ),
      );
      event.currentTarget.focus({ preventScroll: true });
    },
  };
  return {
    id,
    selectedRow,
    selectedTime: selectedRow?.time ?? null,
    plotProps,
    reset,
  };
}

export function ChartSelectionReadout({
  selection,
  label,
  summary,
}: {
  selection: ReturnType<typeof useChartSelection>;
  label: string;
  summary: string;
}) {
  const selected = selection.selectedRow;
  return (
    <>
      <p id={`${selection.id}-help`} className="sr-only">
        Tap the plot to select a time. Use Left and Right to move between
        samples, Home and End for the first and last sample, and Escape to
        return to live values.
      </p>
      {selected ? (
        <div className="chart-selection-readout">
          <output
            id={`${selection.id}-readout`}
            aria-live="polite"
            aria-atomic="true"
          >
            <time dateTime={new Date(selected.time).toISOString()}>
              {new Date(selected.time).toLocaleString()}
            </time>
            <span className="sr-only">. {summary}</span>
          </output>
          <button
            type="button"
            onClick={() => {
              document
                .getElementById(`${selection.id}-plot`)
                ?.focus({ preventScroll: true });
              selection.reset();
            }}
            aria-label={`Return ${label} to live values`}
          >
            Live
          </button>
        </div>
      ) : null}
    </>
  );
}
