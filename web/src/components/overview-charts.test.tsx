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
});
