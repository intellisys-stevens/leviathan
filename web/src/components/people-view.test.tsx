import { StrictMode, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadAlignedHistory } from '../overview-history';
import type { Snapshot } from '../types';
import { PeopleView } from './people-view';
import { clearWorkloadHistoryCache } from './workload-telemetry-chart';
import { systemCapability, systemFixture } from '../test/system-fixture';

function fixture(status: 'available' | 'stale' = 'available'): Snapshot {
  const sampledAt = '2026-08-30T12:00:00Z';
  const memory = {
    totalBytes: 100,
    usedBytes: 40,
    freeBytes: 60,
    source: 'synthetic' as const,
    scope: 'gpu_instance' as const,
    sampledAt,
    status: 'available' as const,
  };
  return {
    schemaVersion: 'v1',
    sequence: 1,
    sampledAt,
    host: { hostname: 'synthetic', os: 'linux', arch: 'amd64' },
    system: systemFixture(sampledAt),
    capabilities: {
      system: systemCapability,
      nvml: { name: 'NVML', available: true, status: 'available' },
      gpm: { name: 'GPM', available: true, status: 'available' },
      dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
      proc: { name: '/proc', available: true, status: 'available' },
      profileMetrics: true,
    },
    diagnostics: [],
    processes: [],
    gpus: [
      {
        uuid: 'GPU-synthetic',
        index: 0,
        name: 'Synthetic GPU',
        migEnabled: true,
        maxMigDevices: 1,
        memory: { ...memory, scope: 'physical_gpu' },
        metrics: {},
        gpuInstances: [
          {
            uuid: 'GI-synthetic',
            id: 1,
            profile: '1g.synthetic',
            generation: 'GI-synthetic@g1',
            memory,
            metrics: {
              sm_activity: {
                value: 62,
                unit: 'percent',
                source: 'synthetic',
                scope: 'gpu_instance',
                sampledAt,
                status: 'available',
              },
            },
            computeInstances: [
              {
                uuid: 'MIG-synthetic',
                id: 2,
                profile: '1c.synthetic',
                generation: 'MIG-synthetic@g1',
                memory,
                metrics: {},
              },
            ],
          },
        ],
      },
      {
        uuid: 'GPU-synthetic-two',
        index: 1,
        name: 'Second Synthetic GPU',
        migEnabled: false,
        maxMigDevices: 0,
        memory: { ...memory, scope: 'physical_gpu' },
        metrics: {
          gpu_activity: {
            value: 37,
            unit: 'percent',
            source: 'synthetic',
            scope: 'physical_gpu',
            sampledAt,
            status: 'available',
          },
        },
        gpuInstances: [],
      },
    ],
    attribution: {
      provider: 'kubernetes_dra',
      status,
      workloads: [
        {
          ref: 'opaque-never-render',
          platform: 'coder',
          kind: 'workspace',
          name: 'synthetic-workspace',
          ownerName: 'synthetic-owner',
        },
        {
          ref: 'opaque-never-render-two',
          platform: 'coder',
          kind: 'workspace',
          name: 'second-synthetic-workspace',
          ownerName: 'second-synthetic-owner',
        },
      ],
      assignments: [
        {
          workloadRef: 'opaque-never-render',
          entityType: 'compute_instance',
          entityUuid: 'MIG-synthetic',
          state: 'allocated',
        },
        {
          workloadRef: 'opaque-never-render-two',
          entityType: 'physical_gpu',
          entityUuid: 'GPU-synthetic-two',
          state: 'reserved',
        },
      ],
    },
  };
}

function historyLoader(): ReturnType<typeof vi.fn<LoadAlignedHistory>> {
  return vi.fn(async (request) => ({
    window: request.window,
    series: request.series,
    points: [
      {
        sampledAt: '2026-08-30T11:59:55Z',
        values: Object.fromEntries(
          request.series.map((descriptor) => [
            descriptor.key,
            {
              [descriptor.metrics[0]]: 20,
              [descriptor.metrics[1]]: 30,
              memory_used_bytes: 20,
              memory_total_bytes: 100,
              pcie_rx_bytes_per_second: 100,
              pcie_tx_bytes_per_second: 50,
            },
          ]),
        ),
      },
      {
        sampledAt: '2026-08-30T12:00:00Z',
        values: Object.fromEntries(
          request.series.map((descriptor) => [
            descriptor.key,
            {
              [descriptor.metrics[0]]: 40,
              [descriptor.metrics[1]]: 50,
              memory_used_bytes: 40,
              memory_total_bytes: 100,
              pcie_rx_bytes_per_second: 200,
              pcie_tx_bytes_per_second: 100,
            },
          ]),
        ),
      },
    ],
  }));
}

function PeopleHarness({
  snapshot,
  onSelect = () => undefined,
  loadHistory = historyLoader(),
  initialPersonKey = null,
  onChartWindowChange = () => undefined,
}: {
  snapshot: Snapshot;
  onSelect?: (selection: import('../types').Selection) => void;
  loadHistory?: LoadAlignedHistory;
  initialPersonKey?: string | null;
  onChartWindowChange?: (milliseconds: number) => void;
}) {
  const [selectedPersonKey, setSelectedPersonKey] = useState<string | null>(
    initialPersonKey,
  );
  return (
    <PeopleView
      snapshot={snapshot}
      onSelect={onSelect}
      selectedPersonKey={selectedPersonKey}
      onSelectedPersonChange={setSelectedPersonKey}
      loadHistory={loadHistory}
      chartWindowMs={30 * 60 * 1000}
      retentionMs={60 * 60 * 1000}
      onChartWindowChange={onChartWindowChange}
    />
  );
}

describe('people resource view', () => {
  beforeEach(() => clearWorkloadHistoryCache());

  it('shows nested workspace resources without leaking opaque refs', () => {
    const onSelect = vi.fn();
    const view = render(
      <PeopleHarness
        snapshot={fixture()}
        onSelect={onSelect}
        initialPersonKey={'coder\u0000synthetic-owner'}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'synthetic-owner' }),
    ).toBeInTheDocument();
    expect(screen.getByText('synthetic-workspace')).toBeInTheDocument();
    expect(
      screen.getAllByText('second-synthetic-owner').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('second-synthetic-workspace')).toBeNull();
    expect(screen.getByText('GPU 0 · GI 1 · CI 2')).toBeInTheDocument();
    expect(screen.queryByText('GPU 1 · Full GPU')).toBeNull();
    expect(screen.queryByText('1g.synthetic · 1c.synthetic')).toBeNull();
    expect(screen.queryByText('Second Synthetic GPU')).toBeNull();
    expect(view.container).not.toHaveTextContent('Parent GI metrics');
    expect(view.container).not.toHaveTextContent('Physical GPU metrics');
    expect(view.container).not.toHaveTextContent('allocated');
    expect(view.container).not.toHaveTextContent('reserved');
    expect(view.container).not.toHaveTextContent('opaque-never-render');

    const activityIcons = view.container.querySelectorAll(
      '.mobile-workload-metrics [data-metric-icon="sm_activity"]',
    );
    expect(activityIcons).toHaveLength(1);
    for (const icon of activityIcons) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
    expect(screen.queryByText('GPU active')).toBeNull();
    expect(screen.getByText('SM active')).toBeInTheDocument();

    const peopleGrid = screen.getByTestId('people-grid');
    expect(peopleGrid).toHaveClass(
      'workloads-master-detail',
      'lg:grid-cols-[15rem_minmax(0,1fr)]',
    );
    expect(screen.getByRole('tablist', { name: 'Users' })).toHaveAttribute(
      'aria-orientation',
      'vertical',
    );
    expect(screen.getByLabelText('Select user')).toHaveClass(
      'workload-owner-select',
      'lg:hidden',
    );
    const personCards = screen.getAllByTestId('person-card');
    expect(personCards).toHaveLength(1);
    for (const personCard of personCards) {
      expect(personCard).toHaveClass('snow-capped', 'mobile-person-card');
      expect(['left', 'right', 'split', 'center', 'corner']).toContain(
        personCard.getAttribute('data-snow-cap'),
      );
      expect(
        personCard.querySelectorAll(':scope > [data-slot="snow-cap"]'),
      ).toHaveLength(1);
      expect(
        personCard.querySelector(':scope > [data-slot="snow-cap"]'),
      ).toHaveAttribute(
        'data-snow-profile',
        personCard.getAttribute('data-snow-cap'),
      );
      expect(
        personCard.querySelector(':scope > .workload-person-header'),
      ).toBeInTheDocument();
    }
    for (const workspaceGrid of screen.getAllByTestId('workspace-grid')) {
      expect(workspaceGrid).toHaveClass(
        'grid',
        'gap-3',
        'mobile-workspace-grid',
      );
      expect(workspaceGrid).not.toHaveClass('xl:grid-cols-2');
    }
    for (const memoryBar of screen.getAllByLabelText(/memory used/u)) {
      expect(memoryBar).toHaveClass(
        '[&_[data-slot=progress-indicator]]:bg-primary',
      );
    }
    expect(
      screen.getByRole('progressbar', {
        name: 'GPU 0 GI 1 parent GI memory used, shared by 1 CI',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', {
        name: 'GPU 0 GI 1 parent GI SM activity, shared by 1 CI',
      }),
    ).toBeInTheDocument();
    for (const progress of screen.getAllByRole('progressbar')) {
      expect(progress.closest('button')).toBeNull();
      const resourceRow = progress.closest('.interactive-resource');
      expect(resourceRow).toBeInTheDocument();
      expect(
        resourceRow?.querySelector(':scope > .interactive-resource-button'),
      ).toBeInTheDocument();
    }

    const computeButton = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 1 · CI 2 details',
    });
    for (const button of [computeButton]) {
      expect(button).toHaveClass(
        'interactive-resource-button',
        'absolute',
        'inset-0',
      );
      expect(button.parentElement).toHaveClass('interactive-resource');
      expect(button.parentElement).toHaveClass('flowing-surface');
      expect(
        button.parentElement?.querySelector(
          ':scope > [data-slot="perimeter-light"]',
        ),
      ).toHaveAttribute('aria-hidden', 'true');
      expect(
        button.parentElement?.querySelector('.resource-chevron'),
      ).toBeInTheDocument();
      expect(button.parentElement).toHaveClass('mobile-workload-resource');
    }

    fireEvent.click(computeButton);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'compute_instance' }),
    );

    fireEvent.change(screen.getByLabelText('Select user'), {
      target: { value: '0' },
    });
    const physicalButton = screen.getByRole('button', {
      name: 'Open GPU 1 · Full GPU details',
    });
    expect(screen.getByText('second-synthetic-workspace')).toBeInTheDocument();
    expect(screen.queryByText('synthetic-workspace')).toBeNull();
    expect(screen.getByText('Second Synthetic GPU')).toBeInTheDocument();
    expect(screen.getByText('GPU active')).toBeInTheDocument();
    onSelect.mockClear();
    physicalButton.focus();
    expect(physicalButton).toHaveFocus();
    fireEvent.click(physicalButton, { detail: 0 });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'physical_gpu' }),
    );
  });

  it('withholds retained assignments when attribution is stale', () => {
    const loadHistory = historyLoader();
    render(
      <PeopleHarness snapshot={fixture('stale')} loadHistory={loadHistory} />,
    );
    expect(screen.getByTestId('people-attribution-state')).toHaveTextContent(
      'Workspace assignments are stale',
    );
    expect(screen.queryByText('synthetic-workspace')).toBeNull();
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it('falls back to the first sorted owner when the selected owner disappears', async () => {
    const initial = fixture();
    const view = render(
      <PeopleHarness
        snapshot={initial}
        initialPersonKey={'coder\u0000synthetic-owner'}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'synthetic-owner' }),
    ).toBeInTheDocument();

    const next = fixture();
    next.attribution!.workloads = next.attribution!.workloads.filter(
      ({ ownerName }) => ownerName === 'second-synthetic-owner',
    );
    next.attribution!.assignments = next.attribution!.assignments.filter(
      ({ workloadRef }) => workloadRef === 'opaque-never-render-two',
    );
    view.rerender(
      <PeopleHarness
        snapshot={next}
        initialPersonKey={'coder\u0000synthetic-owner'}
      />,
    );

    expect(
      await screen.findByRole('heading', {
        name: 'second-synthetic-owner',
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Select user')).toHaveValue('0');
  });

  it('keeps unresolved assignment warnings above and outside the people grid', () => {
    const snapshot = fixture();
    snapshot.attribution?.assignments.push({
      workloadRef: 'opaque-never-render',
      entityType: 'physical_gpu',
      entityUuid: 'GPU-unresolved-synthetic',
      state: 'allocated',
    });
    render(<PeopleHarness snapshot={snapshot} />);

    const warning = screen.getByText(/could not be resolved/u);
    const grid = screen.getByTestId('people-grid');
    expect(warning.parentElement).toBe(grid.parentElement);
    expect([...grid.parentElement!.children].indexOf(warning)).toBeLessThan(
      [...grid.parentElement!.children].indexOf(grid),
    );
  });

  it('loads one dataset and shows all four assigned telemetry charts', async () => {
    const loadHistory = historyLoader();
    const onChartWindowChange = vi.fn();
    render(
      <PeopleHarness
        snapshot={fixture()}
        loadHistory={loadHistory}
        initialPersonKey={'coder\u0000synthetic-owner'}
        onChartWindowChange={onChartWindowChange}
      />,
    );

    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    const request = loadHistory.mock.calls[0][0];
    expect(request.series).toEqual([
      {
        key: 'assigned_0',
        entity: 'GI-synthetic',
        metrics: [
          'sm_activity',
          'dram_activity',
          'memory_used_bytes',
          'memory_total_bytes',
          'pcie_rx_bytes_per_second',
          'pcie_tx_bytes_per_second',
        ],
      },
    ]);
    expect(
      await screen.findByRole('heading', { name: 'Telemetry' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Device-scoped signals, not user usage.'),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Assigned telemetry' }),
    ).toBeNull();
    expect(
      screen.getByRole('radiogroup', { name: 'Telemetry window' }),
    ).toBeInTheDocument();
    for (const chartName of [
      'activity',
      'memory usage',
      'memory activity',
      'pcie transfer',
    ]) {
      expect(
        screen.getByRole('figure', {
          name: `synthetic-owner resource ${chartName} trend`,
        }),
      ).toBeInTheDocument();
    }
    expect(
      screen.queryByRole('radiogroup', { name: 'Telemetry metric' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('radio', {
        name: '5m',
      }),
    );
    expect(onChartWindowChange).toHaveBeenCalledWith(5 * 60 * 1000);
  });

  it('retains the live plot while retrying failed history locally', async () => {
    const loadHistory = vi.fn<LoadAlignedHistory>();
    loadHistory
      .mockRejectedValueOnce(new Error('synthetic history failure'))
      .mockImplementation(historyLoader());
    render(
      <PeopleHarness
        snapshot={fixture()}
        loadHistory={loadHistory}
        initialPersonKey={'coder\u0000synthetic-owner'}
      />,
    );

    expect(
      await screen.findByText(
        'History unavailable. Last complete data retained.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('figure', {
        name: 'synthetic-owner resource activity trend',
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText('History unavailable. Last complete data retained.'),
      ).toBeNull(),
    );
  });

  it('does not request history for a reserved-only selected owner', async () => {
    const loadHistory = historyLoader();
    render(
      <PeopleHarness
        snapshot={fixture()}
        loadHistory={loadHistory}
        initialPersonKey={'coder\u0000second-synthetic-owner'}
      />,
    );

    expect(screen.getByText('No GPU telemetry.')).toBeInTheDocument();
    await Promise.resolve();
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it('uses roving vertical-tab keys and keeps completed owner history cached', async () => {
    const snapshot = fixture();
    snapshot.attribution!.assignments[1].state = 'allocated';
    const loadHistory = historyLoader();
    render(
      <PeopleHarness
        snapshot={snapshot}
        loadHistory={loadHistory}
        initialPersonKey={'coder\u0000synthetic-owner'}
      />,
    );

    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    const firstTab = screen.getByRole('tab', { name: /^synthetic-owner/u });
    const secondTab = screen.getByRole('tab', {
      name: /^second-synthetic-owner/u,
    });
    for (const tab of [firstTab, secondTab]) {
      expect(tab).toHaveClass('flowing-surface');
      expect(
        tab.querySelector(':scope > [data-slot="perimeter-light"]'),
      ).toHaveAttribute('aria-hidden', 'true');
    }
    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: 'ArrowDown' });
    expect(secondTab).toHaveFocus();
    expect(secondTab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(secondTab, { key: 'ArrowUp' });
    expect(firstTab).toHaveFocus();
    expect(firstTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(firstTab, { key: 'Home' });
    expect(secondTab).toHaveFocus();
    expect(secondTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(secondTab, { key: 'End' });
    expect(firstTab).toHaveFocus();
    expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await Promise.resolve();
    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('tabpanel', { name: 'synthetic-owner' }),
    ).toBeInTheDocument();
  });

  it('shares one in-flight history request across StrictMode effect replay', async () => {
    let release: (() => void) | undefined;
    const loadHistory = vi.fn<LoadAlignedHistory>(async (request) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        window: request.window,
        series: request.series,
        points: [],
      };
    });

    render(
      <StrictMode>
        <PeopleHarness
          snapshot={fixture()}
          loadHistory={loadHistory}
          initialPersonKey={'coder\u0000synthetic-owner'}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    release?.();
    await waitFor(() =>
      expect(
        screen.getByRole('figure', {
          name: 'synthetic-owner resource activity trend',
        }),
      ).toHaveAttribute('aria-busy', 'false'),
    );
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});
