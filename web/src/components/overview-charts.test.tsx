import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildTrendRows } from '../chart-trend';
import type { Snapshot } from '../types';
import {
  OverviewCharts,
  SeriesTooltip,
  summarizeSeries,
} from './overview-charts';

const payload = [
  {
    dataKey: 'series_0',
    name: 'GPU 0',
    value: 42,
    color: '#00b8a9',
  },
  {
    dataKey: 'series_1',
    name: 'GPU 1',
    value: 73.5,
    color: '#f5a524',
  },
];

describe('overview chart tooltip', () => {
  it('shows all available series normally and only the focused series on focus', () => {
    const tooltip = render(
      <SeriesTooltip
        active
        payload={payload}
        label={Date.parse('2026-08-29T12:00:00Z')}
        activeDataKey={null}
        unit="%"
      />,
    );

    expect(screen.getByText('GPU 0')).toBeInTheDocument();
    expect(screen.getByText('GPU 1')).toBeInTheDocument();
    expect(screen.getByText('42.0%')).toBeInTheDocument();
    expect(screen.getByText('73.5%')).toBeInTheDocument();

    tooltip.rerender(
      <SeriesTooltip
        active
        payload={payload}
        label={Date.parse('2026-08-29T12:00:00Z')}
        activeDataKey="series_1"
        unit="%"
      />,
    );

    expect(screen.queryByText('GPU 0')).not.toBeInTheDocument();
    expect(screen.queryByText('42.0%')).not.toBeInTheDocument();
    expect(screen.getByText('GPU 1')).toBeInTheDocument();
    expect(screen.getByText('73.5%')).toBeInTheDocument();
  });

  it('shows exact PCIe totals with RX and TX detail', () => {
    render(
      <SeriesTooltip
        active
        payload={[
          {
            dataKey: 'series_0',
            name: 'GPU 0',
            value: 1_610_612_736,
            color: '#00b8a9',
            payload: {
              time: Date.parse('2026-08-29T12:00:00Z'),
              series_0: 1_610_612_736,
              series_0_rx: 1_073_741_824,
              series_0_tx: 536_870_912,
            },
          },
        ]}
        label={Date.parse('2026-08-29T12:00:00Z')}
        activeDataKey={null}
        unit="bytes_per_second"
        testId="pcie-throughput-chart-tooltip"
      />,
    );

    expect(
      screen.getByTestId('pcie-throughput-chart-tooltip'),
    ).toBeInTheDocument();
    expect(screen.getByText('1.5 GiB/s')).toBeInTheDocument();
    expect(
      screen.getByText('RX 1.0 GiB/s · TX 512.0 MiB/s'),
    ).toBeInTheDocument();
  });

  it('uses a responsive multi-column layout for large tooltips', () => {
    render(
      <SeriesTooltip
        active
        payload={Array.from({ length: 7 }, (_, index) => ({
          dataKey: `series_${index}`,
          name: `GPU ${index}`,
          value: index,
          color: '#00b8a9',
        }))}
        label={Date.parse('2026-08-29T12:00:00Z')}
        activeDataKey={null}
        unit="%"
        testId="memory-chart-tooltip"
      />,
    );

    const values = screen.getByTestId('memory-chart-tooltip').lastElementChild;
    expect(values).toHaveClass('grid-cols-1', 'sm:grid-cols-2');
  });

  it('identifies the stable trend and its source samples', () => {
    render(
      <SeriesTooltip
        active
        payload={[
          {
            dataKey: 'series_0',
            name: 'GPU 0',
            value: 42,
            color: '#00b8a9',
            payload: {
              time: Date.parse('2026-08-29T12:00:00Z'),
              series_0: 42,
              series_0__trend_count: 3,
              series_0__trend_latest: 45,
              series_0__trend_minimum: 40,
              series_0__trend_maximum: 45,
              series_0__trend_partial: 1,
            },
          },
        ]}
        label={Date.parse('2026-08-29T12:00:00Z')}
        activeDataKey={null}
        unit="%"
      />,
    );

    expect(screen.getByText('Trend 42.0%')).toBeInTheDocument();
    expect(
      screen.getByText('Latest 45.0% · 3 samples · live bucket'),
    ).toBeInTheDocument();
    expect(screen.getByText('Min 40.0% · Max 45.0%')).toBeInTheDocument();
  });

  it('keeps current, minimum, and maximum summaries based on source samples', () => {
    const rows = buildTrendRows(
      [
        { time: 1_000, value: 10 },
        { time: 2_000, value: 50 },
        { time: 3_000, value: 20 },
      ],
      ['value'],
      30 * 60_000,
    );

    expect(rows[0].value).toBeCloseTo(26.67, 1);
    expect(summarizeSeries(rows, 'value')).toEqual({
      current: 20,
      minimum: 10,
      maximum: 50,
    });
  });
});

describe('overview metric presentation', () => {
  it('uses the canonical icon for every chart family', () => {
    const provider = {
      name: 'synthetic',
      available: true,
      status: 'available' as const,
    };
    const snapshot: Snapshot = {
      schemaVersion: 'v1',
      sequence: 1,
      sampledAt: '2026-08-29T12:00:00Z',
      host: { hostname: 'synthetic', os: 'linux', arch: 'amd64' },
      gpus: [],
      processes: [],
      diagnostics: [],
      capabilities: {
        nvml: provider,
        gpm: provider,
        dcgm: provider,
        proc: provider,
        profileMetrics: true,
      },
    };
    render(
      <OverviewCharts
        snapshot={snapshot}
        connection="live"
        chartWindowMs={30 * 60_000}
        retentionMs={60 * 60_000}
        loadHistory={async (request) => ({
          window: request.window,
          series: request.series,
          points: [],
        })}
      />,
    );

    for (const [panel, metric] of [
      ['utilization-chart', 'gpu_activity'],
      ['memory-chart', 'memory'],
      ['temperature-chart', 'temperature'],
      ['memory-activity-chart', 'memory_activity'],
      ['pcie-throughput-chart', 'pcie_total_bytes_per_second'],
    ]) {
      expect(
        screen
          .getByTestId(panel)
          .querySelector(`[data-metric-icon="${metric}"]`),
      ).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
