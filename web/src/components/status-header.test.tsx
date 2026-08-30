import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSettings } from '../types';
import { StatusHeader } from './status-header';

function settings(samplingIntervalMs = 1000): RuntimeSettings {
  return {
    samplingIntervalMs,
    profileIntervalMs: 2000,
    processIntervalMs: 5000,
    historyWindowMs: 60 * 60 * 1000,
    allowedSamplingIntervalsMs: [500, 1000, 2000],
  };
}

function header(
  overrides: Partial<React.ComponentProps<typeof StatusHeader>> = {},
) {
  return (
    <StatusHeader
      hostname="fixture-host"
      connection="live"
      degraded={false}
      settings={settings()}
      theme="dark"
      onSamplingIntervalChange={vi.fn(async () => settings(500))}
      onToggleTheme={vi.fn()}
      {...overrides}
    />
  );
}

describe('StatusHeader sampling controls', () => {
  it('renders a borderless status beside one neutral desktop control', () => {
    render(header());

    const desktop = screen.getByTestId('desktop-live-sampling');
    const combined = within(desktop).getByLabelText('Live status and sampling');
    expect(combined).not.toHaveClass('border', 'bg-primary/[0.07]');
    const brandMark = document.querySelector<HTMLElement>(
      '[style*="miglens-mark.png"]',
    );
    expect(brandMark).toHaveClass('bg-foreground');
    expect(brandMark).toHaveAttribute('aria-hidden', 'true');
    expect(
      within(desktop).getByRole('status', {
        name: 'Connection status: Live',
      }),
    ).toHaveTextContent('Live');
    expect(within(desktop).queryByText('Sampling')).toBeNull();

    const control = within(desktop).getByRole('group', {
      name: 'Sampling interval',
    });
    expect(control).toHaveClass('gap-1', 'border-border/80', 'bg-muted/50');
    expect(
      within(control)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['0.5s', '1s', '2s']);
    expect(within(control).getByRole('button', { name: '1s' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (const option of within(control).getAllByRole('button')) {
      expect(option).toHaveClass('min-w-10', 'flex-none');
    }
    const repositoryLink = screen.getByRole('link', {
      name: 'Open MIGLens repository on GitHub',
    });
    expect(repositoryLink).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/miglens',
    );
    expect(repositoryLink).toHaveAttribute('target', '_blank');
    expect(repositoryLink).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByRole('banner')).not.toHaveTextContent('NVML + GPM');
  });

  it('keeps a custom segment selected and rolls back a failed optimistic update', async () => {
    let rejectUpdate: ((reason: Error) => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<RuntimeSettings>((_resolve, reject) => {
          rejectUpdate = reject;
        }),
    );
    render(
      header({
        settings: settings(250),
        onSamplingIntervalChange: update,
      }),
    );

    const desktop = screen.getByTestId('desktop-live-sampling');
    const custom = within(desktop).getByRole('button', {
      name: 'Custom 0.25s',
    });
    expect(custom).toHaveAttribute('aria-pressed', 'true');

    const halfSecond = within(desktop).getByRole('button', { name: '0.5s' });
    fireEvent.click(halfSecond);
    fireEvent.click(halfSecond);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(500);
    expect(halfSecond).toHaveAttribute('aria-pressed', 'true');
    expect(halfSecond.querySelector('.animate-spin')).toBeInTheDocument();
    expect(
      within(desktop).getByRole('group', { name: 'Sampling interval' }),
    ).toHaveAttribute('aria-busy', 'true');

    rejectUpdate?.(new Error('Sampling update failed.'));

    await waitFor(() => expect(custom).toHaveAttribute('aria-pressed', 'true'));
    const alert = within(desktop).getByRole('alert');
    expect(alert).toHaveTextContent('Sampling update failed.');
    expect(alert).toHaveClass('absolute');
    expect(screen.queryByTestId('sampling-update-status')).toBeNull();
  });

  it('uses the same neutral compact treatment for the mobile popover', async () => {
    render(header());

    const trigger = screen.getByRole('button', {
      name: 'Live status, sampling 1s',
    });
    expect(trigger).toHaveTextContent('Live · 1s');
    expect(trigger).toHaveClass('border-border/80', 'bg-muted/50');
    expect(trigger).not.toHaveClass('border-primary/25', 'bg-primary/[0.08]');

    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Live cadence')).toBeInTheDocument();
    expect(
      within(dialog).getByText('GPU metrics 1s · profiles 2s · processes 5s'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('group', { name: 'Sampling interval' }),
    ).toHaveClass('gap-1', 'border-border/80', 'bg-muted/50');
    for (const option of within(dialog).getAllByRole('button')) {
      expect(option).toHaveClass('min-w-0', 'flex-1');
      expect(option).not.toHaveClass('min-w-10');
    }
  });
});
