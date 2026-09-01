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
    for (const label of ['1h', '4h', '12h']) {
      expect(within(group).getByRole('radio', { name: label })).toBeDisabled();
    }
    const mobile = screen.getByRole('combobox', { name: 'Chart window' });
    expect(mobile).toHaveValue(String(30 * 60 * 1000));
    expect(mobile.parentElement).toHaveClass(
      'chart-window-mobile',
      'flowing-surface',
    );
    expect(
      mobile.parentElement?.querySelector(
        ':scope > [data-slot="perimeter-light"]',
      ),
    ).toBeInTheDocument();
    expect(within(mobile).getByRole('option', { name: '12h' })).toBeDisabled();

    fireEvent.click(within(group).getByRole('radio', { name: '15m' }));
    expect(onChartWindowChange).toHaveBeenCalledWith(15 * 60 * 1000);
    fireEvent.change(mobile, { target: { value: String(5 * 60 * 1000) } });
    expect(onChartWindowChange).toHaveBeenCalledWith(5 * 60 * 1000);
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
    for (const label of ['5m', '15m', '30m', '1h', '4h', '12h']) {
      expect(within(group).getByRole('radio', { name: label })).toBeDisabled();
    }
    const custom = within(group).getByRole('radio', {
      name: 'Current custom window 4m',
    });
    expect(custom).toBeChecked();
    expect(custom).toBeDisabled();
  });
});
