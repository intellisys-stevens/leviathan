import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GPU, Snapshot } from '../types';
import { systemCapability, systemFixture } from '../test/system-fixture';
import {
  busiestFilesystem,
  CapacityOverview,
  gpuCapacity,
} from './system-overview';

const sampledAt = '2026-09-02T12:00:00Z';

function snapshot(): Snapshot {
  return {
    schemaVersion: 'v1',
    sequence: 1,
    sampledAt,
    host: { hostname: 'cpu-only', os: 'linux', arch: 'amd64' },
    system: systemFixture(sampledAt),
    gpus: [],
    processes: [],
    diagnostics: [],
    capabilities: {
      system: systemCapability,
      nvml: { name: 'NVML', available: false, status: 'unsupported' },
      gpm: { name: 'GPM', available: false, status: 'unsupported' },
      dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
      proc: { name: '/proc', available: false, status: 'unsupported' },
      profileMetrics: false,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('whole-machine capacity', () => {
  it('uses the same gauge for capacity across single and mixed GPU inventories', () => {
    const data = snapshot();
    const gpu: GPU = {
      uuid: 'GPU-brand',
      index: 0,
      name: 'NVIDIA RTX PRO 6000',
      migEnabled: false,
      maxMigDevices: 0,
      memory: {
        totalBytes: 80 * 1024 ** 3,
        usedBytes: 20 * 1024 ** 3,
        freeBytes: 60 * 1024 ** 3,
        sampledAt,
        source: 'nvml',
        scope: 'physical_gpu',
        status: 'available',
      },
      metrics: {},
      gpuInstances: [],
    };
    data.gpus = [gpu];
    const view = render(
      <CapacityOverview snapshot={data} onNavigate={() => {}} />,
    );
    const card = screen.getByRole('button', { name: 'Inspect GPU resources' });
    expect(card.querySelector('.lucide-gauge')).not.toBeNull();
    expect(card.querySelector('[data-gpu-brand]')).toBeNull();
    data.gpus = [
      ...data.gpus,
      { ...gpu, uuid: 'GPU-amd', name: 'AMD Instinct MI300X' },
    ];
    view.rerender(<CapacityOverview snapshot={data} onNavigate={() => {}} />);
    expect(card.querySelector('.lucide-gauge')).not.toBeNull();
    expect(card.querySelector('[data-gpu-brand]')).toBeNull();
  });

  it('shows four equal resource categories and routes each inspection', () => {
    const navigate = vi.fn();
    render(<CapacityOverview snapshot={snapshot()} onNavigate={navigate} />);
    for (const [label, key] of [
      ['CPU', 'cpu'],
      ['RAM', 'memory'],
      ['GPU', 'gpu'],
      ['Storage', 'storage'],
    ]) {
      fireEvent.click(
        screen.getByRole('button', { name: `Inspect ${label} resources` }),
      );
      expect(navigate).toHaveBeenLastCalledWith(key);
    }
    expect(screen.getByText('37.0% utilized')).toBeInTheDocument();
    expect(screen.getByText('GPU discovery unavailable')).toBeInTheDocument();
    expect(screen.getByText('logical processors')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Inspect CPU resources',
      'Inspect RAM resources',
      'Inspect GPU resources',
      'Inspect Storage resources',
    ]);
  });

  it('counts physical VRAM once and labels incomplete totals', () => {
    const data = snapshot();
    data.capabilities.nvml.available = true;
    data.capabilities.nvml.status = 'available';
    const gpu = {
      uuid: 'GPU-one',
      memory: {
        status: 'available',
        totalBytes: 80 * 1024 ** 3,
        usedBytes: 20 * 1024 ** 3,
      },
      gpuInstances: [{ memory: { totalBytes: 80 * 1024 ** 3 } }],
    } as GPU;
    data.gpus = [gpu, gpu];
    expect(gpuCapacity(data)).toMatchObject({
      count: 1,
      total: 80 * 1024 ** 3,
      complete: true,
    });
    data.gpus.push({
      ...gpu,
      uuid: 'GPU-two',
      memory: { ...gpu.memory, status: 'stale' },
    });
    expect(gpuCapacity(data)).toMatchObject({
      status: 'partial',
      reported: 1,
      complete: false,
    });
  });

  it('distinguishes partial storage and surfaces the fullest mount', () => {
    const data = snapshot();
    const storage = data.system.storage;
    storage.filesystems.push({
      ...storage.filesystems[0],
      id: 'full',
      mountPoint: '/small',
      usedBytes: 95,
      totalBytes: 100,
    });
    storage.filesystems.push({
      ...storage.filesystems[0],
      id: 'missing',
      mountPoint: '/missing',
      status: 'permission_denied',
      usedBytes: null,
      totalBytes: null,
    });
    storage.status = 'stale';
    expect(busiestFilesystem(storage.filesystems)?.mountPoint).toBe('/small');
    render(<CapacityOverview snapshot={data} onNavigate={() => {}} />);
    const card = screen.getByRole('button', {
      name: 'Inspect Storage resources',
    });
    expect(card).toHaveTextContent('reported capacity');
    expect(card).toHaveTextContent('Stale');
    expect(card).toHaveTextContent('Usage unavailable');
    expect(card).not.toHaveTextContent('420.0 GiB used');
    expect(card).toHaveTextContent('Highest: /small · 95%');
    expect(within(card).getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      'Unavailable',
    );
  });

  it.each(['estimated', 'stale'] as const)(
    'labels %s utilization independently of available CPU and RAM domains',
    (status) => {
      const data = snapshot();
      data.system.cpu.utilization.status = status;
      data.system.memory.utilization.status = status;
      render(
        <>
          <CapacityOverview snapshot={data} onNavigate={() => {}} />
        </>,
      );
      for (const name of ['CPU', 'RAM']) {
        const card = screen.getByRole('button', {
          name: `Inspect ${name} resources`,
        });
        expect(card).toHaveTextContent(
          status === 'stale' ? 'Stale' : 'Estimated',
        );
        const bar = within(card).getByRole('progressbar');
        if (status === 'stale') {
          expect(bar).toHaveAttribute('aria-valuetext', 'Unavailable');
        } else {
          expect(bar).toHaveAttribute('aria-valuenow');
        }
      }
    },
  );

  it('retains raw VRAM provenance independently from unknown assignment capacity', () => {
    const data = snapshot();
    data.capabilities.nvml = {
      name: 'NVML',
      available: true,
      status: 'available',
    };
    data.gpus = [
      {
        uuid: 'GPU-one',
        memory: {
          status: 'estimated',
          totalBytes: 80 * 1024 ** 3,
          usedBytes: 20 * 1024 ** 3,
        },
        gpuInstances: [],
      } as unknown as GPU,
    ];
    const { rerender } = render(
      <CapacityOverview snapshot={data} onNavigate={() => {}} />,
    );
    const card = screen.getByRole('button', { name: 'Inspect GPU resources' });
    expect(gpuCapacity(data)).toMatchObject({
      status: 'estimated',
      used: 20 * 1024 ** 3,
      total: 80 * 1024 ** 3,
    });
    expect(card).toHaveTextContent('Unknown');
    expect(card).toHaveTextContent('Workspace attribution is not configured');
    expect(card).not.toHaveTextContent('VRAM');
    data.capabilities.nvml = {
      name: 'NVML',
      available: false,
      status: 'stale',
    };
    rerender(<CapacityOverview snapshot={data} onNavigate={() => {}} />);
    expect(card).toHaveTextContent('Unknown');
    expect(card).toHaveTextContent('GPU discovery is stale');
    expect(card).not.toHaveTextContent('20.0 GiB');
    expect(
      within(card).getByText('GPU assignments: Unknown'),
    ).toBeInTheDocument();
  });

  it('shows compact occupied capacity while retaining exact assignment counts accessibly', () => {
    const data = snapshot();
    data.capabilities.nvml = {
      name: 'NVML',
      available: true,
      status: 'available',
    };
    data.gpus = [0, 1, 2].map((index) => ({
      uuid: `GPU-${index}`,
      index,
      name: 'NVIDIA test',
      migEnabled: false,
      maxMigDevices: 0,
      memory: {
        status: 'available',
        totalBytes: 100,
        usedBytes: 0,
        freeBytes: 100,
        source: 'nvml',
        scope: 'physical_gpu',
        sampledAt,
      },
      metrics: {},
      gpuInstances: [],
    }));
    data.attribution = {
      provider: 'kubernetes_dra',
      resolution: {
        status: 'complete',
        unresolvedAssignments: 0,
        reasonCodes: [],
        workloads: [],
      },
      status: 'available',
      observedAt: sampledAt,
      workloads: [
        {
          ref: 'workspace-one',
          name: 'one',
          ownerName: 'owner',
          kind: 'workspace',
          platform: 'coder',
        },
      ],
      assignments: [
        {
          workloadRef: 'workspace-one',
          entityType: 'physical_gpu',
          entityUuid: 'GPU-0',
          state: 'allocated',
        },
        {
          workloadRef: 'workspace-one',
          entityType: 'physical_gpu',
          entityUuid: 'GPU-1',
          state: 'reserved',
        },
      ],
    };
    const { rerender } = render(
      <CapacityOverview snapshot={data} onNavigate={() => {}} />,
    );
    const card = screen.getByRole('button', { name: 'Inspect GPU resources' });
    expect(card.querySelector('.host-capacity-value')).toHaveTextContent('1');
    expect(card).toHaveTextContent('unassigned resources');
    expect(card).toHaveAccessibleDescription(
      /Observed workspace assignments: 1 assigned, 1 reserved, 1 unassigned/,
    );
    expect(card.querySelector('.host-capacity-detail')).toHaveTextContent(
      '2 of 3 in use · 1 reserved',
    );
    expect(card.querySelector('.gpu-allocation-legend')).toBeNull();
    expect(card.querySelector('.host-capacity-footnote')).toBeNull();
    expect(card.querySelector('.gpu-allocation-bar > span')).toHaveStyle({
      width: `${(2 / 3) * 100}%`,
    });
    expect(
      within(card).getByRole('meter', { name: 'GPU assignments' }),
    ).toHaveAttribute('aria-valuetext', '1 assigned, 1 reserved, 1 unassigned');
    data.attribution.assignments = [];
    rerender(<CapacityOverview snapshot={data} onNavigate={() => {}} />);
    expect(card.querySelector('.host-capacity-detail')).toHaveTextContent(
      '0 of 3 in use',
    );
    expect(card.querySelector('.host-capacity-detail')).not.toHaveTextContent(
      'reserved',
    );
    expect(card.querySelector('.gpu-allocation-bar > span')).toHaveStyle({
      width: '0%',
    });
    data.gpus = [{ ...data.gpus[0], migEnabled: true, gpuInstances: [] }];
    rerender(<CapacityOverview snapshot={data} onNavigate={() => {}} />);
    expect(card.querySelector('.host-capacity-value')).toHaveTextContent('0');
    expect(card.querySelector('.host-capacity-detail')).toHaveTextContent(
      'No configured resources',
    );
    expect(card.querySelector('.gpu-allocation-bar > span')).toBeNull();
    rerender(<CapacityOverview snapshot={data} stale onNavigate={() => {}} />);
    expect(card).toHaveTextContent('Unknown');
    expect(card).toHaveTextContent('Live assignment availability is stale');
    expect(card.querySelector('.gpu-allocation-legend')).toBeNull();
  });
});
