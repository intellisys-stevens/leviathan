import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildTrendRows } from '../chart-trend';
import type { ChartRow } from '../overview-history';
import { AssignedTelemetryTooltip } from './workload-telemetry-chart';

const windowMilliseconds = 5 * 60 * 1000;

function TooltipHarness({ row }: { row: ChartRow }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={anchorRef} />
      <AssignedTelemetryTooltip
        active
        anchorRef={anchorRef}
        coordinate={{ x: 12, y: 12 }}
        label={row.time}
        payload={[
          {
            color: 'rgb(0, 128, 255)',
            dataKey: 'assigned_0_activity',
            name: 'GPU 0',
            value: row.assigned_0_activity as number,
            payload: row,
          },
        ]}
      />
    </>
  );
}

describe('assigned telemetry tooltip', () => {
  it('shows only a timestamp and the plotted series value', () => {
    const bucketEnd = 1_000;
    const [row] = buildTrendRows(
      [
        { time: bucketEnd - 900, assigned_0_activity: 10 },
        { time: bucketEnd - 100, assigned_0_activity: 30 },
      ],
      ['assigned_0_activity'],
      windowMilliseconds,
    );

    render(<TooltipHarness row={row} />);

    const tooltip = screen.getByTestId('assigned-telemetry-tooltip');
    expect(tooltip).toHaveTextContent('GPU 0');
    expect(tooltip).toHaveTextContent('20%');
    expect(tooltip).not.toHaveTextContent(
      /Trend|Latest|min|max|sample|bucket/i,
    );
  });
});
