import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartWindowControl } from './chart-window-control';

describe('ChartWindowControl', () => {
  it('uses the shared segmented control and retains disabled ranges', () => {
    const onChartWindowChange = vi.fn();
    render(
      <ChartWindowControl
        chartWindowMs={30 * 60 * 1000}
        retentionMs={30 * 60 * 1000}
        onChartWindowChange={onChartWindowChange}
      />,
    );

    const group = screen.getByRole('radiogroup', { name: 'Chart window' });
    expect(group).toHaveClass('segmented-control');
    expect(within(group).getByRole('radio', { name: '30m' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: '1h' })).toBeDisabled();

    fireEvent.click(within(group).getByRole('radio', { name: '15m' }));
    expect(onChartWindowChange).toHaveBeenCalledWith(15 * 60 * 1000);
  });

  it('shows a selected custom effective range when no preset fits', () => {
    render(
      <ChartWindowControl
        chartWindowMs={4 * 60 * 1000}
        retentionMs={4 * 60 * 1000}
        onChartWindowChange={vi.fn()}
        ariaLabel="Detail chart window"
      />,
    );

    const group = screen.getByRole('radiogroup', {
      name: 'Detail chart window',
    });
    for (const label of ['5m', '15m', '30m', '1h']) {
      expect(within(group).getByRole('radio', { name: label })).toBeDisabled();
    }
    const custom = within(group).getByRole('radio', {
      name: 'Current custom window 4m',
    });
    expect(custom).toBeChecked();
    expect(custom).toBeDisabled();
  });
});
