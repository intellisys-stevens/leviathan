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

function settings(samplingIntervalMs = 500): RuntimeSettings {
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
      onToggleTheme={vi.fn()}
      {...overrides}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StatusHeader fixed cadence', () => {
  it('renders a compact fixed cadence beside the live status', () => {
    render(header());
    const desktop = screen.getByTestId('desktop-live-sampling');
    expect(
      within(desktop).getByRole('status', {
        name: 'Connection status: Live',
      }),
    ).toHaveTextContent('Live');
    expect(
      within(desktop).getByLabelText('View updates every 0.5s'),
    ).toHaveTextContent('0.5s');
    expect(
      screen.queryByRole('radiogroup', { name: 'View updates' }),
    ).toBeNull();
    expect(screen.getByTestId('leviathan-header-mark')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('keeps collection settings read-only and retry errors actionable', () => {
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
    expect(
      within(desktop).getByLabelText('View updates every 0.5s'),
    ).toHaveTextContent('0.5s');
    expect(
      screen.queryByRole('radiogroup', { name: 'View updates' }),
    ).toBeNull();
  });

  it('retains the fixed browser interval when collection settings are missing or slower', () => {
    const view = render(header({ settings: null }));
    for (const configuration of [null, settings(1000), settings(2000)]) {
      view.rerender(header({ settings: configuration }));
      expect(
        screen.getByLabelText('View updates every 0.5s'),
      ).toHaveTextContent('0.5s');
      expect(
        screen.queryByRole('radiogroup', { name: 'View updates' }),
      ).toBeNull();
    }
    expect(
      screen.getByTitle(
        'Host samples 2s · profiles 2s · processes 5s. Browser view updates 0.5s.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps mobile connection details without cadence choices', async () => {
    render(header());
    const trigger = screen.getByRole('button', {
      name: 'Live status, view updates 0.5s',
    });
    expect(trigger).toHaveTextContent('Live · 0.5s');
    expect(trigger).toHaveClass('border-input', 'bg-popover');
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('View updates')).toBeInTheDocument();
    expect(within(dialog).getByText('fixture-host')).toBeVisible();
    expect(within(dialog).getByText('Live')).toBeVisible();
    expect(
      within(dialog).queryByText(
        /This browser updates|Host samples|profiles|processes/,
      ),
    ).toBeNull();
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('exposes the repository and theme actions directly without an app menu', () => {
    const onToggleTheme = vi.fn();
    const view = render(header({ onToggleTheme }));
    expect(screen.queryByRole('button', { name: 'Open app menu' })).toBeNull();
    const repository = screen.getByRole('link', {
      name: 'Open Leviathan repository on GitHub',
    });
    expect(repository).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
    expect(repository).toHaveClass('min-h-11', 'min-w-11');
    const toggle = screen.getByRole('button', { name: 'Use light theme' });
    expect(toggle).toHaveClass('min-h-11', 'min-w-11');
    fireEvent.click(toggle);
    expect(onToggleTheme).toHaveBeenCalledOnce();
    view.rerender(header({ theme: 'light', onToggleTheme }));
    expect(
      screen.getByRole('button', { name: 'Use dark theme' }),
    ).toBeInTheDocument();
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
        name: 'Live status, view updates 0.5s',
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
