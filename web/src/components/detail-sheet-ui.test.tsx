import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GPU, HistorySeries, Metric, Selection } from '../types';
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

describe('detail sheet presentation', () => {
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
});
