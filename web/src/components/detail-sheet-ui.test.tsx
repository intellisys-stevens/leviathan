import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  GPU,
  GpuInstance,
  HistorySeries,
  Metric,
  Selection,
} from '../types';
import DetailSheet from './detail-sheet';

const sampledAt = '2026-08-29T12:00:00Z';

function metric(
  value: number | null,
  unit: string,
  status: Metric['status'] = 'available',
): Metric {
  return {
    value,
    unit,
    source: 'nvml_gpm',
    scope: 'physical_gpu',
    sampledAt,
    status,
    message: status === 'available' ? undefined : 'Synthetic metric issue',
  };
}

function physicalSelection(): Selection {
  const gpu: GPU = {
    uuid: 'GPU-synthetic-0',
    index: 0,
    name: 'Synthetic GPU',
    pciBusId: '0000:01:00.0',
    migEnabled: false,
    maxMigDevices: 0,
    memory: {
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 4 * 1024 ** 3,
      freeBytes: 12 * 1024 ** 3,
      source: 'dcgm',
      scope: 'physical_gpu',
      sampledAt,
      status: 'error',
      message: 'Synthetic memory issue',
    },
    metrics: {
      gpu_activity: metric(42, 'percent'),
      sm_activity: metric(40, 'percent'),
      memory_activity: metric(18, 'percent'),
      pcie_rx_bytes_per_second: metric(1024, 'bytes_per_second'),
      pcie_tx_bytes_per_second: metric(2048, 'bytes_per_second'),
      temperature: metric(null, 'celsius', 'permission_denied'),
      power: metric(120, 'watts'),
      sm_clock: metric(1800, 'megahertz'),
      memory_clock: metric(12000, 'megahertz'),
    },
    gpuInstances: [],
  };
  return { kind: 'physical_gpu', gpu };
}

function computeSelection(): Selection {
  const selection = physicalSelection();
  if (selection.kind !== 'physical_gpu') throw new Error('Expected GPU');
  const gpu = selection.gpu;
  const gi = {
    uuid: 'GPU-synthetic-0/gi/3',
    id: 3,
    profile: '1g.24gb',
    generation: 'GPU-synthetic-0/gi/3@g1',
    memory: {
      ...gpu.memory,
      scope: 'gpu_instance',
      status: 'available',
      message: undefined,
    },
    metrics: {},
    computeInstances: [
      {
        uuid: 'MIG-synthetic-0',
        id: 0,
        profile: '1c.1g.24gb',
        generation: 'MIG-synthetic-0@g1',
        memory: {
          ...gpu.memory,
          scope: 'gpu_instance',
          status: 'available',
          message: undefined,
        },
        metrics: {},
      },
    ],
  } satisfies GpuInstance;
  gpu.migEnabled = true;
  gpu.gpuInstances = [gi];
  return {
    kind: 'compute_instance',
    gpu,
    gi,
    ci: gi.computeInstances[0],
  };
}

function history(): HistorySeries {
  return {
    entity: 'GPU-synthetic-0',
    metrics: [
      'gpu_activity',
      'sm_activity',
      'memory_activity',
      'pcie_rx_bytes_per_second',
      'pcie_tx_bytes_per_second',
    ],
    window: '30m0s',
    points: [
      {
        sampledAt: '2026-08-29T11:59:59Z',
        values: {
          gpu_activity: 40,
          sm_activity: 38,
          memory_activity: 16,
          pcie_rx_bytes_per_second: 900,
          pcie_tx_bytes_per_second: 1900,
        },
      },
      {
        sampledAt,
        values: {
          gpu_activity: 42,
          sm_activity: 40,
          memory_activity: 18,
          pcie_rx_bytes_per_second: 1024,
          pcie_tx_bytes_per_second: 2048,
        },
      },
    ],
  };
}

function replacementHistory(): HistorySeries {
  return {
    ...history(),
    window: '5m0s',
    points: [
      {
        sampledAt: '2026-08-29T11:59:00Z',
        values: {
          gpu_activity: 80,
          sm_activity: 70,
          memory_activity: 60,
          pcie_rx_bytes_per_second: 3_000,
          pcie_tx_bytes_per_second: 4_000,
        },
      },
      {
        sampledAt: '2026-08-29T11:59:01Z',
        values: {
          gpu_activity: 90,
          sm_activity: 80,
          memory_activity: 70,
          pcie_rx_bytes_per_second: 5_000,
          pcie_tx_bytes_per_second: 6_000,
        },
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('detail sheet presentation', () => {
  it('uses one resource heading and concise profile metadata', async () => {
    const loadHistory = vi.fn().mockResolvedValue(history());
    render(
      <DetailSheet
        selection={computeSelection()}
        open
        onOpenChange={() => undefined}
        loadHistory={loadHistory}
        chartWindowMs={30 * 60 * 1000}
        retentionMs={60 * 60 * 1000}
        onChartWindowChange={() => undefined}
      />,
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'GPU 0 · GI 3 · CI 0',
    });
    expect(dialog).toHaveClass(
      'detail-sheet-surface',
      'mobile-detail-sheet',
      'w-full',
      'max-w-none',
    );
    expect(dialog).not.toHaveClass('md:max-w-[640px]');
    const header = dialog.querySelector('[data-slot="sheet-header"]');
    expect(header).not.toBeNull();
    expect(header).toHaveClass('mobile-detail-sheet-header');
    const headerQueries = within(header as HTMLElement);

    expect(headerQueries.getAllByText('GPU 0 · GI 3 · CI 0')).toHaveLength(1);
    expect(headerQueries.getByText('1g.24gb')).toBeInTheDocument();
    expect(headerQueries.getByText('1c.1g.24gb')).toBeInTheDocument();
    expect(headerQueries.getByText('GI')).toBeInTheDocument();
    expect(headerQueries.getByText('CI')).toBeInTheDocument();
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(close).toBeInTheDocument();
    expect(close.closest('[data-slot="sheet-header"]')).toBe(header);
    expect(header).toHaveClass('mobile-detail-sheet-header', 'relative');

    const liveMetrics = within(dialog).getByTestId('detail-live-metrics');
    expect(liveMetrics).toHaveClass(
      'detail-live-metrics',
      'detail-live-metrics-instance',
      'grid-cols-2',
      'sm:grid-cols-4',
    );
    expect(liveMetrics).not.toHaveClass('lg:grid-cols-5');
    expect(liveMetrics.children).toHaveLength(7);
    for (const tile of liveMetrics.children) {
      const icon = tile.querySelector('[data-metric-icon]');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
    expect(
      within(dialog).getByRole('heading', { name: 'History', level: 3 }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: 'Activity', level: 4 }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', {
        name: 'PCIe transfer',
        level: 4,
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('figure', { name: '30m activity history' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('figure', {
        name: '30m PCIe transfer history',
      }),
    ).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Current / minimum / maximum data');
    expect(
      within(dialog).getAllByRole('radiogroup', {
        name: 'Detail chart window',
      }),
    ).toHaveLength(1);
  });

  it('omits metric provenance footers and the PCIe explanatory sentence', async () => {
    const loadHistory = vi.fn().mockResolvedValue(history());
    render(
      <DetailSheet
        selection={physicalSelection()}
        open
        onOpenChange={() => undefined}
        loadHistory={loadHistory}
        chartWindowMs={30 * 60 * 1000}
        retentionMs={60 * 60 * 1000}
        onChartWindowChange={() => undefined}
      />,
    );

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(loadHistory).toHaveBeenCalledOnce());

    const liveMetrics = within(dialog).getByTestId('detail-live-metrics');
    expect(liveMetrics).toHaveClass(
      'detail-live-metrics',
      'detail-live-metrics-physical',
      'grid-cols-2',
      'sm:grid-cols-4',
      'lg:grid-cols-5',
    );
    expect(liveMetrics.children).toHaveLength(10);
    for (const tile of liveMetrics.children) {
      expect(tile.querySelector('[data-metric-icon]')).toHaveAttribute(
        'aria-hidden',
        'true',
      );
    }
    for (const chart of [
      within(dialog).getByTestId('detail-history-chart'),
      within(dialog).getByTestId('detail-pcie-chart'),
    ]) {
      expect(chart).toHaveClass('detail-chart-frame', 'h-[216px]', 'md:h-56');
      expect(chart.querySelector('[data-chart-curve="linear"]')).not.toBeNull();
    }

    expect(
      within(dialog).queryByText(
        'Measured transfer rate, shown independently by direction.',
      ),
    ).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(
      /(?:nvml_gpm|dcgm)\s*·\s*(?:physical_gpu|gpu_instance)\s*·\s*(?:available|permission_denied|error)/u,
    );

    const temperature = within(dialog).getByText('Temperature').parentElement;
    expect(temperature).toHaveTextContent('—');
    const memory = within(dialog).getByText('Full GPU memory').parentElement;
    expect(memory).not.toHaveTextContent('dcgm');
    expect(memory).not.toHaveTextContent('error');
    expect(
      within(dialog).getByRole('progressbar', {
        name: 'Full GPU memory used',
      }),
    ).toHaveClass('[&_[data-slot=progress-indicator]]:bg-primary');
    expect(dialog).not.toHaveTextContent('GPU-synthetic-0');
    for (const tick of ['0%', '25%', '50%', '75%', '100%']) {
      expect(within(dialog).getByText(tick)).toBeInTheDocument();
    }
    expect(dialog).not.toHaveTextContent(/(?:-0(?:\.0)?%|99964%)/u);
  });

  it('retains the complete plot while loading and crossfades replacement history for 140ms', async () => {
    const selection = physicalSelection();
    const next = deferred<HistorySeries>();
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce(history())
      .mockReturnValueOnce(next.promise);
    const props = {
      selection,
      open: true,
      onOpenChange: () => undefined,
      loadHistory,
      retentionMs: 60 * 60 * 1000,
      onChartWindowChange: () => undefined,
    };
    const view = render(
      <DetailSheet {...props} chartWindowMs={30 * 60 * 1000} />,
    );

    const dialog = await screen.findByRole('dialog');
    const activityChart = within(dialog).getByTestId('detail-history-chart');
    const pcieChart = within(dialog).getByTestId('detail-pcie-chart');
    await waitFor(() =>
      expect(activityChart.querySelectorAll('.chart-plot-layer')).toHaveLength(
        1,
      ),
    );
    const activityLegend = within(dialog).getByLabelText(
      'Activity chart series',
    );
    const oldSummary =
      within(activityLegend).getByLabelText(/GPU activity:/u).textContent;

    view.rerender(<DetailSheet {...props} chartWindowMs={5 * 60 * 1000} />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    expect(activityChart).toHaveAttribute('aria-busy', 'true');
    expect(activityChart.querySelectorAll('.chart-plot-layer')).toHaveLength(1);
    expect(pcieChart.querySelectorAll('.chart-plot-layer')).toHaveLength(1);
    expect(within(dialog).queryByText('Collecting history…')).toBeNull();
    expect(
      within(activityLegend).getByLabelText(/GPU activity:/u),
    ).toHaveTextContent(oldSummary ?? '');

    vi.useFakeTimers();
    try {
      await act(async () => {
        next.resolve(replacementHistory());
        await next.promise;
      });

      for (const chart of [activityChart, pcieChart]) {
        expect(chart).toHaveAttribute('aria-busy', 'false');
        expect(chart.querySelectorAll('.chart-plot-layer')).toHaveLength(2);
        expect(chart.querySelector('.chart-plot-incoming')).not.toBeNull();
        expect(chart.querySelector('.chart-plot-outgoing')).not.toBeNull();
      }
      expect(
        within(activityLegend).getByLabelText(/GPU activity:/u),
      ).toHaveTextContent(oldSummary ?? '');

      await act(() => vi.advanceTimersByTime(139));
      expect(activityChart.querySelectorAll('.chart-plot-layer')).toHaveLength(
        2,
      );
      expect(pcieChart.querySelectorAll('.chart-plot-layer')).toHaveLength(2);

      await act(() => vi.advanceTimersByTime(1));
      for (const chart of [activityChart, pcieChart]) {
        expect(chart.querySelectorAll('.chart-plot-layer')).toHaveLength(1);
        expect(chart.querySelector('.chart-plot-incoming')).toBeNull();
        expect(chart.querySelector('.chart-plot-outgoing')).toBeNull();
      }
      expect(
        within(activityLegend).getByLabelText(/GPU activity:/u),
      ).toHaveTextContent(oldSummary ?? '');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('retains the complete plot and exposes a scoped retry after history failure', async () => {
    const selection = physicalSelection();
    const failed = deferred<HistorySeries>();
    const retry = deferred<HistorySeries>();
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce(history())
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    const props = {
      selection,
      open: true,
      onOpenChange: () => undefined,
      loadHistory,
      retentionMs: 60 * 60 * 1000,
      onChartWindowChange: () => undefined,
    };
    const view = render(
      <DetailSheet {...props} chartWindowMs={30 * 60 * 1000} />,
    );

    const dialog = await screen.findByRole('dialog');
    const activityChart = within(dialog).getByTestId('detail-history-chart');
    await waitFor(() =>
      expect(activityChart.querySelectorAll('.chart-plot-layer')).toHaveLength(
        1,
      ),
    );
    const activityLegend = within(dialog).getByLabelText(
      'Activity chart series',
    );
    const retainedSummary =
      within(activityLegend).getByLabelText(/GPU activity:/u).textContent;

    view.rerender(<DetailSheet {...props} chartWindowMs={5 * 60 * 1000} />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    await act(async () => {
      failed.reject(new Error('range unavailable'));
      await failed.promise.catch(() => undefined);
    });

    expect(activityChart).toHaveAttribute('aria-busy', 'false');
    expect(activityChart.querySelectorAll('.chart-plot-layer')).toHaveLength(1);
    expect(
      within(activityLegend).getByLabelText(/GPU activity:/u),
    ).toHaveTextContent(retainedSummary ?? '');
    expect(
      within(dialog).getByText(
        'range unavailable. Last complete history retained.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(3));
    expect(loadHistory).toHaveBeenLastCalledWith(
      selection.gpu.uuid,
      expect.any(Array),
      '5m',
    );
    expect(activityChart).toHaveAttribute('aria-busy', 'true');
    expect(activityChart.querySelectorAll('.chart-plot-layer')).toHaveLength(1);
    expect(
      within(dialog).queryByText(/Last complete history retained/u),
    ).toBeNull();
  });
});
