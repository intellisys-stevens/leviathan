import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      displayCadenceMs={1000}
      onDisplayCadenceChange={vi.fn()}
      onToggleTheme={vi.fn()}
      {...overrides}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StatusHeader view cadence controls', () => {
  it('renders a borderless status beside one neutral desktop control', () => {
    render(header());

    const desktop = screen.getByTestId('desktop-live-sampling');
    const combined = within(desktop).getByLabelText(
      'Live status and view updates',
    );
    expect(combined).not.toHaveClass('border', 'bg-primary/[0.07]');
    const brandMark = document.querySelector<HTMLElement>(
      '[style*="leviathan-mark.svg"]',
    );
    expect(brandMark).toHaveClass('bg-primary');
    expect(brandMark).toHaveAttribute('aria-hidden', 'true');
    expect(
      within(desktop).getByRole('status', {
        name: 'Connection status: Live',
      }),
    ).toHaveTextContent('Live');
    expect(within(desktop).queryByText('Sampling')).toBeNull();

    const control = within(desktop).getByRole('radiogroup', {
      name: 'View updates',
    });
    expect(control).toHaveClass('segmented-control');
    expect(
      within(control)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('aria-label')),
    ).toEqual(['Every sample', '1s', '2s']);
    expect(within(control).getByRole('radio', { name: '1s' })).toBeChecked();
    expect(control.querySelector('.segmented-thumb')).toHaveClass(
      'transition-transform',
      'duration-200',
      'motion-reduce:transition-none',
    );
    expect(screen.getByRole('banner')).toHaveTextContent('fixture-host');
    expect(screen.getByRole('banner')).not.toHaveTextContent('local read-only');
    const repositoryLink = screen.getByRole('link', {
      name: 'Open Leviathan repository on GitHub',
    });
    expect(repositoryLink).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
    expect(repositoryLink).toHaveAttribute('target', '_blank');
    expect(repositoryLink).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByRole('banner')).not.toHaveTextContent('NVML + GPM');
  });

  it('changes only the browser-local display cadence', () => {
    const onDisplayCadenceChange = vi.fn();
    const view = render(header({ onDisplayCadenceChange }));
    const desktop = screen.getByTestId('desktop-live-sampling');
    fireEvent.click(within(desktop).getByRole('radio', { name: '2s' }));
    expect(onDisplayCadenceChange).toHaveBeenCalledWith(2000);
    view.rerender(header({ displayCadenceMs: 2000, onDisplayCadenceChange }));
    expect(within(desktop).getByRole('radio', { name: '2s' })).toBeChecked();
  });

  it('keeps host sampling read-only and scopes settings errors', () => {
    const retry = vi.fn();
    render(
      header({
        settings: settings(250),
        settingsError: 'Settings unavailable',
        onRetrySettings: retry,
      }),
    );
    const desktop = screen.getByTestId('desktop-live-sampling');
    expect(within(desktop).getByRole('alert')).toHaveTextContent(
      'Settings unavailable',
    );
    fireEvent.click(within(desktop).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(within(desktop).queryByRole('radio', { name: '0.25s' })).toBeNull();
  });

  it('uses the same neutral compact treatment for the mobile popover', async () => {
    render(header());

    const trigger = screen.getByRole('button', {
      name: 'Live status, view updates 1s',
    });
    expect(trigger).toHaveTextContent('Live · 1s');
    expect(trigger).toHaveClass('border-input', 'bg-popover');
    expect(trigger).not.toHaveClass('border-primary/25', 'bg-primary/[0.08]');

    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('View updates')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Host samples 1s · profiles 2s · processes 5s/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('radiogroup', { name: 'View updates' }),
    ).toHaveClass('segmented-control', 'w-full');
    expect(within(dialog).getAllByRole('radio')).toHaveLength(3);
  });

  it('keeps secondary mobile actions in a concise More popover', async () => {
    const onToggleTheme = vi.fn();
    render(header({ onToggleTheme }));

    const mark = screen.getByTestId('leviathan-header-mark');
    expect(mark).toHaveClass('size-8', 'md:size-10');
    expect(screen.getByText('fixture-host')).toHaveClass('hidden', 'md:block');

    const trigger = screen.getByRole('button', { name: 'Open app menu' });
    expect(trigger.closest('.mobile-header-more')).not.toBeNull();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'App menu' });
    const repository = within(dialog).getByRole('link', {
      name: 'Open Leviathan repository on GitHub',
    });
    expect(repository).toHaveTextContent('GitHub Repo');
    expect(
      within(dialog).getByRole('button', { name: 'Use light theme' }),
    ).toHaveTextContent('Light Theme');
    expect(repository).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Use light theme' }),
    );
    expect(onToggleTheme).toHaveBeenCalledOnce();
  });

  it('closes the portaled mobile popover when the desktop breakpoint activates', async () => {
    let desktop = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      get matches() {
        return desktop;
      },
      media: '(min-width: 768px)',
      onchange: null,
      addEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => listeners.add(listener),
      removeEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => listeners.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media),
    );

    render(header());
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Live status, view updates 1s',
      }),
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    act(() => {
      desktop = true;
      const event = {
        matches: true,
        media: media.media,
      } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
