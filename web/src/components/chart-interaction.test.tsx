import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChartRow } from '../overview-history';
import {
  ChartSelectionReadout,
  compactChartValue,
  nearestChartSample,
  useChartSelection,
} from './chart-interaction';

const rows: ChartRow[] = [
  { time: 1_000, cpu: 12 },
  { time: 2_000, cpu: null },
  { time: 10_000, cpu: 53 },
];

function Plot({
  samples = rows,
  scope = 'cpu',
}: {
  samples?: ChartRow[];
  scope?: string;
}) {
  const selection = useChartSelection(samples, [1_000, 10_000], scope);
  const value = selection.selectedRow?.cpu;
  const summary = value == null ? 'Unavailable' : `${value}%`;
  return (
    <>
      <figure aria-label="CPU history" {...selection.plotProps}>
        <button type="button">Retry history</button>
      </figure>
      <span data-testid="selected">{selection.selectedTime ?? 'live'}</span>
      <ChartSelectionReadout
        selection={selection}
        label="CPU"
        summary={summary}
      />
    </>
  );
}

describe('direct chart selection', () => {
  it('supports keyboard samples, explicit missing values and a Live reset without a disclosure', () => {
    render(<Plot />);
    const plot = screen.getByRole('figure', { name: 'CPU history' });
    expect(plot).toHaveAttribute('tabindex', '0');
    expect(screen.queryByText('Inspect history')).not.toBeInTheDocument();
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(screen.getByTestId('selected')).toHaveTextContent('1000');
    expect(screen.getByRole('status')).toHaveTextContent('12%');
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable');
    fireEvent.keyDown(plot, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('53%');
    fireEvent.click(
      screen.getByRole('button', { name: 'Return CPU to live values' }),
    );
    expect(plot).toHaveFocus();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(screen.getByTestId('selected')).toHaveTextContent('2000');
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(screen.getByTestId('selected')).toHaveTextContent('live');
  });

  it('maps taps by elapsed time rather than treating uneven samples as equally spaced', () => {
    render(<Plot />);
    const plot = screen.getByRole('figure');
    vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      width: 900,
    } as DOMRect);
    fireEvent.click(plot, { clientX: 300 });
    expect(screen.getByTestId('selected')).toHaveTextContent('2000');
    fireEvent.click(plot, { clientX: 950 });
    expect(screen.getByTestId('selected')).toHaveTextContent('10000');
    fireEvent.click(
      screen.getByRole('button', { name: 'Return CPU to live values' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
    expect(screen.getByTestId('selected')).toHaveTextContent('live');
  });

  it('keeps the selected timestamp across polling and clears it for a different resource', () => {
    const view = render(<Plot />);
    fireEvent.keyDown(screen.getByRole('figure'), { key: 'Home' });
    view.rerender(<Plot samples={[...rows, { time: 11_000, cpu: 70 }]} />);
    expect(screen.getByTestId('selected')).toHaveTextContent('1000');
    view.rerender(<Plot scope="storage" />);
    expect(screen.getByTestId('selected')).toHaveTextContent('live');
  });

  it('leaves an empty plot out of the tab order and bounds the nearest sample', () => {
    render(<Plot samples={[]} />);
    expect(screen.getByRole('figure')).not.toHaveAttribute('tabindex');
    expect(nearestChartSample([], 0)).toBe(-1);
    expect(nearestChartSample(rows, -100)).toBe(0);
    expect(nearestChartSample(rows, 30_000)).toBe(2);
    expect(nearestChartSample(rows, 3_000)).toBe(1);
  });
});

describe('compact legend values', () => {
  it('uses binary rates with three significant digits and promotes rounded units', () => {
    expect(compactChartValue(554.1 * 1024, 'bytes_per_second')).toBe(
      '554 KiB/s',
    );
    expect(compactChartValue(1.2345 * 1024 ** 2, 'bytes_per_second')).toBe(
      '1.23 MiB/s',
    );
    expect(compactChartValue(1023.96 * 1024, 'bytes_per_second')).toBe(
      '1 MiB/s',
    );
    expect(compactChartValue(0, 'bytes_per_second')).toBe('0 B/s');
    expect(compactChartValue(null, 'bytes_per_second')).toBe('—');
  });

  it('keeps missing and very small nonzero percentages distinct from zero', () => {
    expect(compactChartValue(0.04, '%')).toBe('<0.1%');
    expect(compactChartValue(0, '%')).toBe('0%');
    expect(compactChartValue(12.36, '%')).toBe('12.4%');
    expect(compactChartValue(100, '%')).toBe('100%');
    expect(compactChartValue(NaN, '%')).toBe('—');
    expect(compactChartValue(46.6, '°C')).toBe('47°C');
  });
});
