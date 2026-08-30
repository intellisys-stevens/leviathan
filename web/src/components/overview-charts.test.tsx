import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SeriesTooltip } from './overview-charts';

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
});
