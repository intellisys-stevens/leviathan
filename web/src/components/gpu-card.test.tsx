import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ComputeInstance,
  GPU,
  GpuInstance,
  Memory,
  Metric,
} from '../types';
import { GPUCard } from './gpu-card';

const sampledAt = '2026-08-31T12:00:00Z';

function memory(scope: Memory['scope']): Memory {
  return {
    totalBytes: 100,
    usedBytes: 40,
    freeBytes: 60,
    source: 'synthetic',
    scope,
    sampledAt,
    status: 'available',
  };
}

function metric(value: number): Metric {
  return {
    value,
    unit: 'percent',
    source: 'synthetic',
    scope: 'gpu_instance',
    sampledAt,
    status: 'available',
  };
}

function physicalMetric(
  value: number | null,
  unit = 'percent',
  status: Metric['status'] = 'available',
): Metric {
  return {
    value,
    unit,
    source: 'synthetic',
    scope: 'physical_gpu',
    sampledAt,
    status,
  };
}

function computeInstance(id: number): ComputeInstance {
  return {
    uuid: `MIG-synthetic-${id}`,
    id,
    profile: `1c.synthetic.${id}`,
    generation: `MIG-synthetic-${id}@g1`,
    memory: memory('compute_instance'),
    metrics: {},
  };
}

function gpuInstance(
  id: number,
  computeInstances: ComputeInstance[],
): GpuInstance {
  return {
    uuid: `GI-synthetic-${id}`,
    id,
    profile: `2g.synthetic.${id}`,
    generation: `GI-synthetic-${id}@g1`,
    memory: memory('gpu_instance'),
    metrics: { sm_activity: metric(62) },
    computeInstances,
  };
}

function gpu(gpuInstances: GpuInstance[] = [], migEnabled = false): GPU {
  return {
    uuid: 'GPU-synthetic-0',
    index: 0,
    name: 'Synthetic GPU',
    migEnabled,
    maxMigDevices: migEnabled ? 8 : 0,
    memory: memory('physical_gpu'),
    metrics: {},
    gpuInstances,
  };
}

describe('GPU resource interactions', () => {
  it('stretches a semantic control across the full-GPU resource surface', () => {
    const onSelect = vi.fn();
    const physicalGPU = gpu();
    render(<GPUCard gpu={physicalGPU} onSelect={onSelect} />);

    const button = screen.getByRole('button', {
      name: 'Open GPU 0 full GPU details',
    });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass(
      'interactive-resource-button',
      'absolute',
      'inset-0',
    );
    expect(button.parentElement).toHaveClass('interactive-resource');
    expect(
      button.parentElement?.querySelector('.resource-chevron'),
    ).toBeInTheDocument();
    expect(button.parentElement).toHaveClass('full-gpu-resource');
    expect(button.parentElement).toHaveClass('mobile-resource-surface');
    expect(button.parentElement).toHaveTextContent('Details');
    expect(screen.queryByText('MIG instances')).toBeNull();
    expect(screen.queryByText('0 GI · 0 CI')).toBeNull();
    expect(screen.queryByText(/Full GPU memory:/u)).toBeNull();
    for (const progress of screen.getAllByRole('progressbar')) {
      expect(progress.closest('button')).toBeNull();
    }

    fireEvent.click(button, { clientX: 72, clientY: 18, detail: 1 });
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'physical_gpu',
      gpu: physicalGPU,
    });
  });

  it('shows six ordered full-GPU telemetry tiles', () => {
    const physicalGPU = gpu();
    physicalGPU.metrics = {
      gpu_activity: physicalMetric(71.25),
      sm_activity: physicalMetric(62.5),
      memory_activity: physicalMetric(33.75),
      pcie_rx_bytes_per_second: physicalMetric(1024 ** 3, 'bytes_per_second'),
      pcie_tx_bytes_per_second: physicalMetric(
        512 * 1024 ** 2,
        'bytes_per_second',
      ),
      sm_clock: physicalMetric(1800, 'mhz'),
      memory_clock: physicalMetric(13000, 'mhz'),
    };
    render(<GPUCard gpu={physicalGPU} onSelect={vi.fn()} />);

    const telemetry = screen.getByRole('region', {
      name: 'GPU 0 live telemetry',
    });
    const tiles = telemetry.querySelectorAll<HTMLElement>(
      '.full-gpu-metric-tile',
    );
    expect(tiles[0].parentElement).toHaveClass(
      'auto-rows-fr',
      'grid-cols-2',
      'md:grid-cols-3',
    );
    expect(tiles).toHaveLength(6);
    expect([...tiles].map((tile) => tile.getAttribute('data-metric'))).toEqual([
      'gpu-activity',
      'sm-activity',
      'memory-activity',
      'memory',
      'pcie',
      'clocks',
    ]);
    for (const heading of telemetry.querySelectorAll(
      '.full-gpu-metric-heading',
    )) {
      expect(heading).toHaveClass('flex-col', 'md:flex-row');
    }
    expect(telemetry.querySelectorAll('.full-gpu-metric-heading')).toHaveLength(
      4,
    );

    expect(within(telemetry).getByText('GPU active')).toBeInTheDocument();
    expect(within(telemetry).getByText('71.3%')).toBeInTheDocument();
    expect(within(telemetry).getByText('SM active')).toBeInTheDocument();
    expect(within(telemetry).getByText('62.5%')).toBeInTheDocument();
    expect(within(telemetry).getByText('Memory active')).toBeInTheDocument();
    expect(within(telemetry).getByText('33.8%')).toBeInTheDocument();
    expect(within(tiles[3]).getByText('Memory')).toBeInTheDocument();
    expect(within(telemetry).getByText('40.0%')).toBeInTheDocument();
    expect(within(telemetry).getByText('40 B / 100 B')).toBeInTheDocument();
    expect(within(telemetry).getByText('PCIe')).toBeInTheDocument();
    expect(within(telemetry).getByText('1.5 GiB/s')).toBeInTheDocument();
    expect(
      within(telemetry).getByText('RX 1.0 GiB/s · TX 512.0 MiB/s'),
    ).toHaveClass('full-gpu-pcie-detail', 'whitespace-normal', 'md:truncate');
    expect(
      within(telemetry).getByText('RX 1.0 GiB/s · TX 512.0 MiB/s'),
    ).toHaveAttribute(
      'title',
      'Host to GPU 1.0 GiB/s; GPU to host 512.0 MiB/s',
    );
    expect(within(telemetry).getByText('Clocks')).toBeInTheDocument();
    expect(within(telemetry).getByText('1800 MHz')).toBeInTheDocument();
    expect(within(telemetry).getByText('13000 MHz')).toBeInTheDocument();
    const clockRows = telemetry.querySelectorAll('.full-gpu-clock-row');
    expect(clockRows).toHaveLength(2);
    for (const row of clockRows) {
      expect(row).toHaveClass('flex-col', 'md:flex-row');
    }
    for (const value of telemetry.querySelectorAll('.full-gpu-clock-value')) {
      expect(value).toHaveClass('whitespace-nowrap');
      expect(value).not.toHaveClass('truncate');
    }
    expect(
      telemetry.querySelector('[data-metric="gpu-activity"] .lucide-gauge'),
    ).toBeInTheDocument();
    expect(
      telemetry.querySelector('[data-metric="sm-activity"] .lucide-cpu'),
    ).toBeInTheDocument();
    expect(
      telemetry.querySelector(
        '[data-metric="memory-activity"] .lucide-activity',
      ),
    ).toBeInTheDocument();
    expect(
      within(telemetry).getByLabelText('GPU 0 memory used'),
    ).toHaveAttribute('aria-valuenow', '40');
    expect(
      within(telemetry).getByLabelText('GPU 0 GPU activity'),
    ).toHaveAttribute('aria-valuenow', '71.25');
    expect(
      within(telemetry).getByLabelText('GPU 0 SM activity'),
    ).toHaveAttribute('aria-valuenow', '62.5');
    expect(
      within(telemetry).getByLabelText('GPU 0 memory activity'),
    ).toHaveAttribute('aria-valuenow', '33.75');
  });

  it('keeps unavailable full-GPU telemetry distinct from real zero values', () => {
    const physicalGPU = gpu();
    physicalGPU.memory = {
      ...physicalGPU.memory,
      usedBytes: null,
      status: 'error',
    };
    physicalGPU.metrics = {
      gpu_activity: physicalMetric(0),
      sm_activity: physicalMetric(0, 'percent', 'stale'),
      memory_activity: physicalMetric(0, 'percent', 'permission_denied'),
      pcie_rx_bytes_per_second: physicalMetric(0, 'bytes_per_second'),
      pcie_tx_bytes_per_second: physicalMetric(
        0,
        'bytes_per_second',
        'permission_denied',
      ),
      sm_clock: physicalMetric(0, 'mhz'),
      memory_clock: physicalMetric(0, 'mhz', 'error'),
    };
    render(<GPUCard gpu={physicalGPU} onSelect={vi.fn()} />);

    const telemetry = screen.getByRole('region', {
      name: 'GPU 0 live telemetry',
    });
    const progressBars = within(telemetry).getAllByRole('progressbar');
    expect(progressBars).toHaveLength(4);
    expect(
      within(telemetry).getByLabelText('GPU 0 GPU activity'),
    ).toHaveAttribute('aria-valuenow', '0');
    for (const progress of progressBars.slice(1)) {
      expect(progress).not.toHaveAttribute('aria-valuenow');
      expect(progress).toHaveAttribute('aria-valuetext', 'Unavailable');
    }
    expect(within(telemetry).getByText('0.0%')).toBeInTheDocument();
    expect(within(telemetry).getByText('0 B/s')).toBeInTheDocument();
    expect(within(telemetry).getByText('0 MHz')).toBeInTheDocument();
    expect(within(telemetry).getAllByText('Unavailable')).toHaveLength(3);
    expect(within(telemetry).getAllByText('—').length).toBeGreaterThanOrEqual(
      4,
    );
  });

  it('uses one shared minimum-height body for full-GPU and MIG cards', () => {
    const fullGPU = gpu();
    const migGPU = gpu([gpuInstance(1, [computeInstance(2)])], true);
    const view = render(
      <div>
        <GPUCard gpu={fullGPU} onSelect={vi.fn()} />
        <GPUCard gpu={migGPU} onSelect={vi.fn()} />
      </div>,
    );

    const cards = view.container.querySelectorAll('.gpu-card');
    const resourceBodies =
      view.container.querySelectorAll('.gpu-resource-body');
    expect(cards).toHaveLength(2);
    expect(resourceBodies).toHaveLength(2);
    for (const card of cards) {
      expect(card).toHaveClass('h-full', 'snow-capped', 'mobile-resource-card');
      expect(['left', 'right', 'split', 'center', 'corner']).toContain(
        card.getAttribute('data-snow-cap'),
      );
    }
    for (const body of resourceBodies) {
      expect(body).toHaveClass(
        'flex',
        'flex-1',
        'min-h-[13rem]',
        'mobile-resource-body',
      );
    }
    expect(
      resourceBodies[0].querySelector('.full-gpu-resource'),
    ).not.toBeNull();
    expect(
      resourceBodies[1].querySelector('.mig-resource-grid'),
    ).not.toBeNull();
  });

  it('makes one-CI MIG surfaces activatable without nesting their metrics', () => {
    const onSelect = vi.fn();
    const ci = computeInstance(2);
    const gi = gpuInstance(1, [ci]);
    const migGPU = gpu([gi], true);
    render(<GPUCard gpu={migGPU} onSelect={onSelect} />);

    const button = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 1 / CI 2 details',
    });
    expect(button.parentElement).toHaveClass('interactive-resource');
    expect(button).toHaveClass(
      'interactive-resource-button',
      'absolute',
      'inset-0',
    );
    expect(screen.getByText('GI 1 / CI 2')).toBeInTheDocument();
    expect(screen.getByText('2g.synthetic.1')).toBeInTheDocument();
    expect(screen.queryByText('CI 2 · 1c.synthetic.2')).toBeNull();
    for (const progress of screen.getAllByRole('progressbar')) {
      expect(progress.closest('button')).toBeNull();
    }

    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button, { detail: 0 });
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'compute_instance',
      gpu: migGPU,
      gi,
      ci,
    });
  });

  it('keeps a multi-CI GI static while each CI subcard selects itself', () => {
    const onSelect = vi.fn();
    const firstCI = computeInstance(4);
    const secondCI = computeInstance(5);
    const gi = gpuInstance(3, [firstCI, secondCI]);
    const migGPU = gpu([gi], true);
    render(<GPUCard gpu={migGPU} onSelect={onSelect} />);

    const giIdentity = screen.getByText('GI 3');
    expect(giIdentity.closest('.interactive-resource')).toBeNull();

    const firstButton = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 3 · CI 4 details',
    });
    const secondButton = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 3 · CI 5 details',
    });
    for (const button of [firstButton, secondButton]) {
      expect(button.parentElement).toHaveClass('interactive-resource');
      expect(button).toHaveClass(
        'interactive-resource-button',
        'absolute',
        'inset-0',
      );
      expect(
        button.parentElement?.querySelector('.resource-chevron'),
      ).toBeInTheDocument();
      expect(button.parentElement).toHaveClass('mobile-ci-card');
    }
    for (const progress of screen.getAllByRole('progressbar')) {
      expect(progress.closest('button')).toBeNull();
    }

    fireEvent.click(secondButton);
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'compute_instance',
      gpu: migGPU,
      gi,
      ci: secondCI,
    });
  });
});
