import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../types';
import { systemFixture } from '../test/system-fixture';
import { HostCharts } from './host-charts';

describe('host chart panels', () => {
  it('shows the selected historical value in its legend and restores measured live values', async () => {
    const sampledAt = '2026-09-05T12:00:00Z';
    const snapshot = {
      sampledAt,
      system: systemFixture(sampledAt),
    } as Snapshot;
    const load = vi.fn().mockResolvedValue({
      points: [
        {
          sampledAt: '2026-09-05T11:59:00Z',
          values: { cpu: { cpu_utilization: 12 } },
        },
        { sampledAt: '2026-09-05T11:59:15Z', values: { cpu: {} } },
        {
          sampledAt: '2026-09-05T11:59:30Z',
          values: { cpu: { cpu_utilization: 70 } },
        },
      ],
    });
    render(
      <HostCharts
        snapshot={snapshot}
        connection="live"
        chartWindowMs={30 * 60_000}
        retentionMs={12 * 3600_000}
        loadHistory={load}
      />,
    );
    const cpu = within(screen.getByTestId('host-cpu-chart'));
    await waitFor(() =>
      expect(cpu.getByRole('figure')).toHaveAttribute('aria-busy', 'false'),
    );
    fireEvent.keyDown(cpu.getByRole('figure'), { key: 'Home' });
    expect(
      cpu.getByRole('button', { name: 'Utilization: 12.0%' }),
    ).toHaveTextContent('12%');
    expect(cpu.getByRole('status')).toHaveTextContent('12.0%');
    fireEvent.click(
      cpu.getByRole('button', { name: 'Return CPU to live values' }),
    );
    expect(
      cpu.getByRole('button', { name: 'Utilization: 37.0%' }),
    ).toHaveTextContent('37%');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('exposes estimated and stale metric states even when storage controls occupy the heading', async () => {
    const sampledAt = '2026-09-05T12:00:00Z';
    const snapshot = {
      sampledAt,
      system: systemFixture(sampledAt),
    } as Snapshot;
    snapshot.system.cpu.utilization.status = 'estimated';
    snapshot.system.memory.utilization.status = 'stale';
    snapshot.system.storage.status = 'stale';
    snapshot.system.storage.readBytesPerSecond.status = 'estimated';
    snapshot.system.storage.writeBytesPerSecond.status = 'stale';
    const load = vi.fn().mockResolvedValue({ points: [] });
    render(
      <HostCharts
        snapshot={snapshot}
        connection="live"
        chartWindowMs={30 * 60_000}
        retentionMs={12 * 3600_000}
        loadHistory={load}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Utilization: 37.0% · Estimated' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Used: Stale' }),
    ).toHaveTextContent('—');
    const storage = screen.getByTestId('host-storage-chart');
    expect(
      within(storage).getByRole('button', {
        name: 'Read: 180.0 MiB/s · Estimated',
      }),
    ).toBeInTheDocument();
    expect(
      within(storage).getByRole('button', { name: 'Write: Stale' }),
    ).not.toHaveTextContent('72.0 MiB/s');
    fireEvent.click(within(storage).getByRole('radio', { name: 'Space' }));
    expect(
      within(storage).getByRole('button', { name: 'Space used: Stale' }),
    ).toHaveTextContent('—');
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('loads one history request for three panels and switches storage units', async () => {
    const sampledAt = '2026-09-05T12:00:00Z';
    const snapshot = {
      sampledAt,
      system: systemFixture(sampledAt),
    } as Snapshot;
    const load = vi.fn().mockResolvedValue({ points: [] });
    render(
      <HostCharts
        snapshot={snapshot}
        connection="live"
        chartWindowMs={30 * 60_000}
        retentionMs={12 * 3600_000}
        loadHistory={load}
      >
        <section aria-label="GPU panels">GPU panels</section>
      </HostCharts>,
    );
    const orderedSections = [...document.querySelectorAll('section')];
    expect(
      orderedSections.map(
        (section) =>
          section.getAttribute('data-testid') ??
          section.getAttribute('aria-label'),
      ),
    ).toEqual([
      'host-cpu-chart',
      'host-ram-chart',
      'GPU panels',
      'host-storage-chart',
    ]);
    expect(screen.getByRole('heading', { name: 'CPU' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'RAM' })).toBeInTheDocument();
    const storage = screen.getByTestId('host-storage-chart');
    expect(within(storage).getByText('Read')).toBeInTheDocument();
    expect(within(storage).getByText('180 MiB/s')).toBeInTheDocument();
    fireEvent.click(
      within(storage).getByRole('button', { name: 'Read: 180.0 MiB/s' }),
    );
    fireEvent.click(within(storage).getByRole('radio', { name: 'Space' }));
    expect(within(storage).getByText('Space used')).toBeInTheDocument();
    expect(within(storage).queryByText('Read')).toBeNull();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });
});
