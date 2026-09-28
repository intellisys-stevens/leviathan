import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PluginStatusPanel } from './plugin-status-panel';
import type { PluginReport } from '../use-plugin-report';

const read = vi.hoisted(() => vi.fn());
vi.mock('../use-plugin-report', () => ({ usePluginReport: read }));
const report: PluginReport = {
  plugins: [
    {
      id: 'lab-accelerator',
      implementation: 'custom-device',
      transport: 'unix',
      status: 'partial',
      intervalMs: 2_000,
      dependencies: ['host'],
      capabilities: [
        {
          capability: 'device_inventory',
          revision: 'v2',
          enabled: true,
          status: 'stale',
          observedAt: '2026-09-28T00:00:00Z',
          lastSuccess: '2026-09-27T23:59:00Z',
          message: 'Source unavailable.',
        },
        {
          capability: 'custom_metrics',
          revision: 'v3',
          enabled: false,
          status: 'disabled',
        },
      ],
    },
  ],
};

describe('plugin status panel', () => {
  it('shows reported identities, dependencies and per-capability freshness literally', () => {
    read.mockReturnValue({
      report,
      error: null,
      pending: false,
      refresh: vi.fn(),
    });
    const view = render(<PluginStatusPanel />);
    expect(
      screen.getByRole('heading', { name: 'lab-accelerator' }),
    ).toBeVisible();
    for (const text of [
      'custom-device',
      'Unix socket',
      'host',
      '2 s',
      'device_inventory',
      'v2',
      'stale',
      'custom_metrics',
      'disabled',
      'Source unavailable.',
    ])
      expect(screen.getByText(text)).toBeVisible();
    expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-09-28T00:00:00Z',
    );
    expect(screen.getByText('No')).toBeVisible();
  });

  it('shows an unavailable report without hiding refresh or retained diagnostics', () => {
    const refresh = vi.fn();
    read.mockReturnValue({
      report,
      error: 'Plugin status is unavailable.',
      pending: false,
      refresh,
    });
    render(<PluginStatusPanel />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing the last report.',
    );
    expect(
      screen.getByRole('heading', { name: 'lab-accelerator' }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plugins' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
