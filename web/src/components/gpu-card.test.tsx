import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  Attribution,
  ComputeInstance,
  GPU,
  GpuInstance,
  Memory,
  Metric,
} from '../types';
import { GPUCard } from './gpu-card';
import type { GPUChipRegion } from './gpu-chip';
import type { GPUChipAppearance } from './gpu-chip-appearance';
import { GPU_CHIP_COLORS } from './gpu-chip-appearance';
import type { ReactNode } from 'react';

vi.mock('./gpu-board-view', () => ({
  GPUBoardView: ({
    regions,
    highlightedId,
    topologyKey,
    onHighlight,
    onSelect,
    appearances,
    fallback,
  }: {
    regions: GPUChipRegion[];
    highlightedId: string | null;
    topologyKey: string;
    onHighlight: (id: string | null) => void;
    onSelect: (id: string) => void;
    appearances: readonly GPUChipAppearance[];
    fallback?: ReactNode;
  }) => (
    <>
      <button
        type="button"
        aria-label="Mock board chip pick"
        data-testid="board-view"
        data-highlighted-chip={highlightedId ?? ''}
        data-topology={topologyKey}
        data-appearances={JSON.stringify(appearances)}
        onMouseEnter={() => onHighlight(regions[0]?.id ?? null)}
        onMouseLeave={() => onHighlight(null)}
        onClick={() => {
          if (regions[0]) onSelect(regions[0].id);
        }}
      />
      {fallback}
    </>
  ),
}));

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

describe('GPU chip inspection', () => {
  it('shows a board with compact native chip controls instead of permanent telemetry grids', async () => {
    const physicalGPU = gpu([gpuInstance(1, [computeInstance(2)])], true);
    physicalGPU.name = 'NVIDIA RTX PRO 6000';
    const view = render(<GPUCard gpu={physicalGPU} onSelect={vi.fn()} />);
    await screen.findByTestId('board-view');
    const card = screen.getByRole('article', { name: 'GPU 0' });
    expect(card).toHaveClass('gpu-3d-card');
    expect(card).toHaveAttribute('data-gpu-index', '0');
    expect(card.querySelector('.gpu-identity-icon')).toHaveAttribute(
      'data-gpu-brand',
      'nvidia',
    );
    expect(
      screen.getByRole('button', { name: 'Open GPU 0 · GI 1 · CI 2 details' }),
    ).toHaveClass('gpu-ci-button');
    expect(
      view.container.querySelector(
        '.full-gpu-metrics, .mig-partition, .gpu-chip-summary',
      ),
    ).toBeNull();
    expect(screen.getByText(physicalGPU.name)).not.toHaveClass('truncate');
  });

  it('keeps an empty observed topology explicit and preserves physical GPU inspection', async () => {
    const physicalGPU = gpu([], true);
    physicalGPU.maxMigDevices = 7;
    const onSelect = vi.fn();
    const view = render(<GPUCard gpu={physicalGPU} onSelect={onSelect} />);
    await screen.findByTestId('board-view');
    expect(screen.getByText('No observed MIG instances.')).toBeVisible();
    expect(view.container.querySelector('.gpu-ci-button')).toBeNull();
    expect(view.container).not.toHaveTextContent(
      /7 (?:free|available)|unallocated slots/iu,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open GPU 0 physical GPU details' }),
    );
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'physical_gpu',
      gpu: physicalGPU,
    });
  });

  it('uses one semantic full-GPU chip action and reveals current summary on focus', async () => {
    const physicalGPU = gpu();
    physicalGPU.metrics.sm_activity = physicalMetric(62.5);
    const onSelect = vi.fn();
    const view = render(<GPUCard gpu={physicalGPU} onSelect={onSelect} />);
    await screen.findByTestId('board-view');
    const button = screen.getByRole('button', {
      name: 'Open GPU 0 full GPU details',
    });
    expect(button).toHaveClass('gpu-full-chip-button');
    expect(button).toHaveAttribute('type', 'button');
    expect(view.container.querySelector('.gpu-chip-summary')).toBeNull();
    act(() => button.focus());
    const summary = screen.getByRole('status');
    expect(within(summary).getByText('Memory')).toBeVisible();
    expect(summary).toHaveTextContent('40 B / 100 B');
    expect(summary).toHaveTextContent('62.5%');
    expect(screen.getByTestId('board-view')).toHaveAttribute(
      'data-highlighted-chip',
      physicalGPU.uuid,
    );
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'physical_gpu',
      gpu: physicalGPU,
    });
    act(() => button.blur());
    expect(view.container.querySelector('.gpu-chip-summary')).toBeNull();
  });

  it('reads shared GI memory once for the focused CI without implying per-CI memory', async () => {
    const ci1 = computeInstance(2),
      ci2 = computeInstance(3);
    const gi = gpuInstance(1, [ci1, ci2]);
    ci1.memory.usedBytes = 99;
    ci2.memory.usedBytes = 1;
    render(<GPUCard gpu={gpu([gi], true)} onSelect={vi.fn()} />);
    await screen.findByTestId('board-view');
    for (const id of [2, 3]) {
      const button = screen.getByRole('button', {
        name: `Open GPU 0 · GI 1 · CI ${id} details`,
      });
      act(() => button.focus());
      const summary = screen.getByRole('status');
      expect(within(summary).getAllByText('Shared GI 1 memory')).toHaveLength(
        1,
      );
      expect(summary).toHaveTextContent('40 B / 100 B');
      expect(summary).not.toHaveTextContent('99 B / 100 B');
      expect(summary).toHaveTextContent('Shared GI 1 SM activity');
      expect(button.querySelector('[role="progressbar"]')).toBeNull();
    }
  });

  it('preserves unavailable memory and telemetry failures separately from measured zero', async () => {
    const gi = gpuInstance(1, [computeInstance(2)]);
    gi.memory.status = 'error';
    gi.memory.usedBytes = null;
    gi.metrics.sm_activity = { ...metric(0), status: 'permission_denied' };
    const initial = gpu([gi], true);
    const view = render(<GPUCard gpu={initial} onSelect={vi.fn()} />);
    await screen.findByTestId('board-view');
    const button = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 1 · CI 2 details',
    });
    act(() => button.focus());
    expect(screen.getByRole('status')).toHaveTextContent('Telemetry error');
    expect(
      within(screen.getByRole('status')).getAllByText('Unavailable'),
    ).toHaveLength(2);
    const measured = structuredClone(initial);
    measured.gpuInstances[0].memory = memory('gpu_instance');
    measured.gpuInstances[0].memory.usedBytes = 0;
    measured.gpuInstances[0].metrics.sm_activity = metric(0);
    view.rerender(<GPUCard gpu={measured} onSelect={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('0 B / 100 B');
    expect(screen.getByRole('status')).toHaveTextContent('0.0%');
    expect(screen.queryByText('Telemetry error')).toBeNull();
  });

  it('keeps observed ordering and snapshot identity while each compact CI selects itself', async () => {
    const first = gpuInstance(3, [computeInstance(5), computeInstance(4)]),
      second = gpuInstance(1, [computeInstance(2)]);
    const physicalGPU = gpu([first, second], true);
    const onSelect = vi.fn();
    const view = render(<GPUCard gpu={physicalGPU} onSelect={onSelect} />);
    await screen.findByTestId('board-view');
    expect(
      [...view.container.querySelectorAll('.gpu-ci-button')].map((button) =>
        button.getAttribute('data-ci-uuid'),
      ),
    ).toEqual(['MIG-synthetic-2', 'MIG-synthetic-4', 'MIG-synthetic-5']);
    expect(physicalGPU.gpuInstances.map((gi) => gi.id)).toEqual([3, 1]);
    expect(first.computeInstances.map((ci) => ci.id)).toEqual([5, 4]);
    const button = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 3 · CI 5 details',
    });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'compute_instance',
      gpu: physicalGPU,
      gi: first,
      ci: first.computeInstances[0],
    });
  });

  it('labels estimated SM without treating it as measured activity and prioritizes delayed snapshots', async () => {
    const physicalGPU = gpu([gpuInstance(1, [computeInstance(2)])], true);
    physicalGPU.gpuInstances[0].metrics.sm_activity = {
      ...metric(24),
      status: 'estimated',
    };
    const view = render(<GPUCard gpu={physicalGPU} onSelect={vi.fn()} />);
    const board = await screen.findByTestId('board-view');
    act(() =>
      screen
        .getByRole('button', { name: 'Open GPU 0 · GI 1 · CI 2 details' })
        .focus(),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Shared GI 1 SM activityEstimated 24.0%',
    );
    expect(JSON.parse(board.getAttribute('data-appearances') ?? '')).toEqual([
      { id: 'MIG-synthetic-2', state: 'unknown', activity: null },
    ]);
    const missing = structuredClone(physicalGPU);
    missing.gpuInstances[0].metrics.sm_activity.value = null;
    view.rerender(<GPUCard gpu={missing} onSelect={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Shared GI 1 SM activityEstimated',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('24.0%');
    view.rerender(
      <GPUCard gpu={physicalGPU} live={false} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Shared GI 1 SM activityDelayed',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('Estimated');
  });

  it('preserves focused controls through metric polling and selects the latest sample', async () => {
    const initial = gpu(
      [gpuInstance(3, [computeInstance(4), computeInstance(5)])],
      true,
    );
    const onSelect = vi.fn();
    const view = render(<GPUCard gpu={initial} onSelect={onSelect} />);
    await screen.findByTestId('board-view');
    const button = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 3 · CI 4 details',
    });
    act(() => button.focus());
    const next = structuredClone(initial);
    next.gpuInstances[0].memory.usedBytes = 75;
    next.gpuInstances[0].metrics.sm_activity = metric(82);
    view.rerender(<GPUCard gpu={next} onSelect={onSelect} />);
    expect(
      screen.getByRole('button', { name: 'Open GPU 0 · GI 3 · CI 4 details' }),
    ).toBe(button);
    expect(button).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('75 B / 100 B');
    expect(screen.getByRole('status')).toHaveTextContent('82.0%');
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'compute_instance',
      gpu: next,
      gi: next.gpuInstances[0],
      ci: next.gpuInstances[0].computeInstances[0],
    });
  });

  it('replaces changed CI generations and clears stale summary while preserving unaffected controls', async () => {
    const initial = gpu(
      [gpuInstance(3, [computeInstance(4), computeInstance(5)])],
      true,
    );
    const view = render(<GPUCard gpu={initial} onSelect={vi.fn()} />);
    await screen.findByTestId('board-view');
    const first = screen.getByRole('button', {
        name: 'Open GPU 0 · GI 3 · CI 4 details',
      }),
      unaffected = screen.getByRole('button', {
        name: 'Open GPU 0 · GI 3 · CI 5 details',
      });
    act(() => first.focus());
    const replacement = structuredClone(initial);
    replacement.gpuInstances[0].computeInstances[0].generation =
      'MIG-synthetic-4@g2';
    view.rerender(<GPUCard gpu={replacement} onSelect={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Open GPU 0 · GI 3 · CI 4 details' }),
    ).not.toBe(first);
    expect(
      screen.getByRole('button', { name: 'Open GPU 0 · GI 3 · CI 5 details' }),
    ).toBe(unaffected);
    expect(view.container.querySelector('.gpu-chip-summary')).toBeNull();
    const nextGI = structuredClone(replacement);
    nextGI.gpuInstances[0].generation = 'GI-synthetic-3@g2';
    view.rerender(<GPUCard gpu={nextGI} onSelect={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Open GPU 0 · GI 3 · CI 5 details' }),
    ).not.toBe(unaffected);
  });

  it('connects board highlighting and picking to the native control and exact selection', async () => {
    const physicalGPU = gpu([gpuInstance(1, [computeInstance(2)])], true);
    const onSelect = vi.fn();
    render(<GPUCard gpu={physicalGPU} onSelect={onSelect} />);
    const board = await screen.findByTestId('board-view');
    fireEvent.mouseEnter(board);
    expect(screen.getByRole('status')).toHaveTextContent('GI 1 · CI 2');
    fireEvent.click(board);
    expect(
      screen.getByRole('button', { name: 'Open GPU 0 · GI 1 · CI 2 details' }),
    ).toHaveFocus();
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'compute_instance',
      gpu: physicalGPU,
      gi: physicalGPU.gpuInstances[0],
      ci: physicalGPU.gpuInstances[0].computeInstances[0],
    });
  });

  it('keeps complete assignment owners in accessible descriptions and the focused summary', async () => {
    const physicalGPU = gpu([gpuInstance(3, [computeInstance(4)])], true);
    const attribution: Attribution = {
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
          ref: 'w1',
          platform: 'coder',
          kind: 'workspace',
          ownerName: 'researcher-with-a-long-owner-name',
          name: 'a-very-long-workspace-with-no-omitted-suffix',
        },
      ],
      assignments: [
        {
          workloadRef: 'w1',
          entityType: 'compute_instance',
          entityUuid: 'MIG-synthetic-4',
          state: 'reserved',
        },
      ],
    };
    const view = render(
      <GPUCard
        gpu={physicalGPU}
        attribution={attribution}
        allocationStates={new Map([['MIG-synthetic-4', 'reserved']])}
        onSelect={vi.fn()}
      />,
    );
    await screen.findByTestId('board-view');
    const button = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 3 · CI 4 details',
    });
    expect(button).toHaveAccessibleDescription(
      /researcher-with-a-long-owner-name.*a-very-long-workspace-with-no-omitted-suffix/u,
    );
    act(() => button.focus());
    expect(screen.getByRole('status')).toHaveTextContent(
      attribution.workloads[0].ownerName,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      attribution.workloads[0].name,
    );
    view.rerender(
      <GPUCard
        gpu={physicalGPU}
        attribution={{ ...attribution, status: 'stale' }}
        onSelect={vi.fn()}
      />,
    );
    expect(button).toHaveAttribute('data-allocation-state', 'unknown');
    expect(button).toHaveAccessibleDescription(/Assignment unknown/u);
    expect(screen.getByRole('status')).not.toHaveTextContent(
      attribution.workloads[0].ownerName,
    );
  });

  it.each(['dark', 'light'] as const)(
    'keeps all allocation states visible with shared %s theme colors',
    async (theme) => {
      const physicalGPU = gpu(
        [
          gpuInstance(3, [
            computeInstance(4),
            computeInstance(5),
            computeInstance(6),
            computeInstance(7),
          ]),
        ],
        true,
      );
      const view = render(
        <GPUCard
          gpu={physicalGPU}
          allocationStates={
            new Map([
              ['MIG-synthetic-4', 'unassigned'],
              ['MIG-synthetic-5', 'reserved'],
              ['MIG-synthetic-6', 'unknown'],
              ['MIG-synthetic-7', 'assigned'],
            ])
          }
          theme={theme}
          onSelect={vi.fn()}
        />,
      );
      await screen.findByTestId('board-view');
      expect(
        screen.getAllByRole('button', { name: /GI 3 · CI/iu }),
      ).toHaveLength(4);
      expect(screen.getByText('Unassigned')).toBeVisible();
      expect(screen.getByText('Reserved')).toBeVisible();
      expect(screen.getByText('Unknown')).toBeVisible();
      expect(screen.getByText('Assigned')).toBeVisible();
      const card = screen.getByRole('article', { name: 'GPU 0' });
      for (const state of [
        'assigned',
        'unassigned',
        'reserved',
        'unknown',
      ] as const) {
        expect(card.style.getPropertyValue(`--gpu-chip-${state}`)).toBe(
          GPU_CHIP_COLORS[theme][state],
        );
        expect(
          view.container.querySelector(
            `.gpu-allocation-label[data-allocation-state="${state}"]`,
          ),
        ).not.toBeNull();
        const chip = view.container.querySelector<SVGElement>(
          `.gpu-fallback-chip[data-allocation-state="${state}"]`,
        );
        expect(chip?.style.getPropertyValue('--gpu-chip-tone')).toBe(
          GPU_CHIP_COLORS[theme][state],
        );
      }
      expect(
        view.container.querySelector(
          '[data-allocation-match], [data-unassigned-filter]',
        ),
      ).toBeNull();
    },
  );

  it('updates both sibling chip appearances without remounting and stops activity on retained snapshots', async () => {
    const physicalGPU = gpu(
      [gpuInstance(1, [computeInstance(2), computeInstance(3)])],
      true,
    );
    const allocationStates = new Map([
      ['MIG-synthetic-2', 'assigned'],
      ['MIG-synthetic-3', 'unassigned'],
    ] as const);
    const view = render(
      <GPUCard
        gpu={physicalGPU}
        allocationStates={allocationStates}
        onSelect={vi.fn()}
      />,
    );
    const board = await screen.findByTestId('board-view');
    expect(JSON.parse(board.getAttribute('data-appearances') ?? '')).toEqual([
      { id: 'MIG-synthetic-2', state: 'assigned', activity: 62 },
      { id: 'MIG-synthetic-3', state: 'unassigned', activity: 62 },
    ]);
    const button = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 1 · CI 2 details',
    });
    act(() => button.focus());
    const chip = view.container.querySelector<SVGElement>(
      '.gpu-fallback-chip[data-region-id="MIG-synthetic-2"]',
    );
    const fill = chip?.style.getPropertyValue('--gpu-chip-fill');
    expect(chip).toHaveAttribute('data-highlighted', 'true');
    act(() => button.blur());
    expect(chip?.style.getPropertyValue('--gpu-chip-fill')).toBe(fill);
    act(() => button.focus());
    view.rerender(
      <GPUCard
        gpu={physicalGPU}
        allocationStates={allocationStates}
        live={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('board-view')).toBe(board);
    expect(button).toHaveFocus();
    expect(JSON.parse(board.getAttribute('data-appearances') ?? '')).toEqual([
      { id: 'MIG-synthetic-2', state: 'unknown', activity: null },
      { id: 'MIG-synthetic-3', state: 'unknown', activity: null },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Shared GI 1 SM activityDelayed',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('62.0%');
    expect(chip).toHaveAttribute('data-activity', 'unavailable');
    expect(chip?.style.getPropertyValue('--gpu-chip-fill')).toBe('12%');
  });

  it('places one generated snow layer on each outer GPU card', async () => {
    const first = gpu(),
      second = {
        ...gpu([gpuInstance(1, [computeInstance(2)])], true),
        uuid: 'GPU-1',
        index: 1,
      };
    const view = render(
      <>
        <GPUCard gpu={first} onSelect={vi.fn()} />
        <GPUCard gpu={second} onSelect={vi.fn()} />
      </>,
    );
    await screen.findAllByTestId('board-view');
    for (const card of view.container.querySelectorAll('.gpu-card')) {
      expect(
        card.querySelectorAll(':scope > [data-slot="snow-cap"]'),
      ).toHaveLength(1);
      expect(
        card.querySelector('.gpu-instance-controls [data-slot="snow-cap"]'),
      ).toBeNull();
      expect(card).toHaveAttribute('data-snow-cap', 'generated');
    }
  });
});
