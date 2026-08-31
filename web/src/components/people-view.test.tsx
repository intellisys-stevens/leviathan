import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../types';
import { PeopleView } from './people-view';

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
    capabilities: {
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

describe('people resource view', () => {
  it('shows nested workspace resources without leaking opaque refs', () => {
    const onSelect = vi.fn();
    const view = render(
      <PeopleView snapshot={fixture()} onSelect={onSelect} />,
    );

    expect(screen.getByText('synthetic-owner')).toBeInTheDocument();
    expect(screen.getByText('synthetic-workspace')).toBeInTheDocument();
    expect(screen.getByText('second-synthetic-owner')).toBeInTheDocument();
    expect(screen.getByText('second-synthetic-workspace')).toBeInTheDocument();
    expect(screen.getByText('GPU 0 · GI 1 · CI 2')).toBeInTheDocument();
    expect(screen.getByText('GPU 1 · Full GPU')).toBeInTheDocument();
    expect(screen.queryByText('1g.synthetic · 1c.synthetic')).toBeNull();
    expect(screen.getByText('Second Synthetic GPU')).toBeInTheDocument();
    expect(screen.getByText('Parent GI metrics')).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent('opaque-never-render');

    const peopleGrid = screen.getByTestId('people-grid');
    expect(peopleGrid).toHaveClass('grid', 'gap-4', 'xl:grid-cols-2');
    const personCards = screen.getAllByTestId('person-card');
    expect(personCards).toHaveLength(2);
    expect(
      new Set(personCards.map((card) => card.getAttribute('data-snow-cap')))
        .size,
    ).toBe(2);
    for (const personCard of personCards) {
      expect(personCard).toHaveClass('snow-capped', 'mobile-person-card');
      expect(['left', 'right', 'split', 'center', 'corner']).toContain(
        personCard.getAttribute('data-snow-cap'),
      );
    }
    for (const workspaceGrid of screen.getAllByTestId('workspace-grid')) {
      expect(workspaceGrid).toHaveClass(
        'grid',
        'gap-3',
        'mobile-workspace-grid',
      );
      expect(workspaceGrid).not.toHaveClass('xl:grid-cols-2');
    }
    for (const memoryBar of screen.getAllByLabelText(/memory used$/u)) {
      expect(memoryBar).toHaveClass(
        '[&_[data-slot=progress-indicator]]:bg-primary',
      );
    }
    for (const progress of screen.getAllByRole('progressbar')) {
      expect(progress.closest('button')).toBeNull();
    }

    const computeButton = screen.getByRole('button', {
      name: 'Open GPU 0 · GI 1 · CI 2 details',
    });
    const physicalButton = screen.getByRole('button', {
      name: 'Open GPU 1 · Full GPU details',
    });
    for (const button of [computeButton, physicalButton]) {
      expect(button).toHaveClass(
        'interactive-resource-button',
        'absolute',
        'inset-0',
      );
      expect(button.parentElement).toHaveClass('interactive-resource');
      expect(
        button.parentElement?.querySelector('.resource-chevron'),
      ).toBeInTheDocument();
      expect(button.parentElement).toHaveClass('mobile-workload-resource');
    }

    fireEvent.click(computeButton);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'compute_instance' }),
    );

    onSelect.mockClear();
    physicalButton.focus();
    expect(physicalButton).toHaveFocus();
    fireEvent.click(physicalButton, { detail: 0 });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'physical_gpu' }),
    );
  });

  it('withholds retained assignments when attribution is stale', () => {
    render(<PeopleView snapshot={fixture('stale')} onSelect={vi.fn()} />);
    expect(screen.getByTestId('people-attribution-state')).toHaveTextContent(
      'Workspace assignments are stale',
    );
    expect(screen.queryByText('synthetic-workspace')).toBeNull();
  });

  it('keeps unresolved assignment warnings above and outside the people grid', () => {
    const snapshot = fixture();
    snapshot.attribution?.assignments.push({
      workloadRef: 'opaque-never-render',
      entityType: 'physical_gpu',
      entityUuid: 'GPU-unresolved-synthetic',
      state: 'allocated',
    });
    render(<PeopleView snapshot={snapshot} onSelect={vi.fn()} />);

    const warning = screen.getByText(/could not be resolved/u);
    const grid = screen.getByTestId('people-grid');
    expect(warning.parentElement).toBe(grid.parentElement);
    expect([...grid.parentElement!.children].indexOf(warning)).toBeLessThan(
      [...grid.parentElement!.children].indexOf(grid),
    );
  });
});
