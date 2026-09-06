import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildPeopleAttributionView } from '../attribution';
import { systemFixture, systemCapability } from '../test/system-fixture';
import { ownerFixture } from '../test/owner-fixture';
import type { Snapshot } from '../types';
import { PeopleView } from './people-view';
import { formatOwnerValue, ownerMetricState } from './owner-telemetry-chart';

function snapshot(): Snapshot {
  return {
    schemaVersion: 'v1',
    sequence: 1,
    host: { hostname: 'test-host', os: 'linux', arch: 'amd64' },
    system: systemFixture('2026-09-05T12:00:00Z'),
    processes: [],
    diagnostics: [],
    capabilities: {
      system: systemCapability,
      nvml: { name: 'nvml', available: false, status: 'unsupported' },
      gpm: { name: 'gpm', available: false, status: 'unsupported' },
      dcgm: { name: 'dcgm', available: false, status: 'unsupported' },
      proc: { name: 'proc', available: false, status: 'unsupported' },
      profileMetrics: false,
    },
    sampledAt: '2026-09-05T12:00:00Z',
    gpus: [],
    workloadTelemetry: {
      sampledAt: '2026-09-05T12:00:00Z',
      status: 'available',
      owners: [ownerFixture()],
    },
  } as Snapshot;
}

describe('owner resource telemetry', () => {
  it('shows CPU-only inventory failures when GPU attribution is absent', () => {
    const data = snapshot();
    data.workloadTelemetry = {
      sampledAt: data.sampledAt,
      status: 'unavailable',
      message: 'Check Pod metadata permissions.',
      owners: [],
    };
    render(
      <PeopleView
        snapshot={data}
        onSelect={vi.fn()}
        selectedPersonKey={null}
        onSelectedPersonChange={vi.fn()}
        loadHistory={vi.fn()}
        chartWindowMs={1800000}
        retentionMs={3600000}
        onChartWindowChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('workload-inventory-state')).toHaveTextContent(
      'Check Pod metadata permissions.',
    );
    expect(
      screen.queryByText('Workspace attribution is not configured'),
    ).toBeNull();
  });
  it('includes CPU-only owners independently of missing GPU attribution and shares one history/range control', async () => {
    const data = snapshot();
    const loadHistory = vi.fn(async (request) => ({
      ...request,
      points: [
        {
          sampledAt: '2026-09-05T11:59:40Z',
          values: {
            owner: {
              cpu_cores: 1,
              memory_used_bytes: 2 ** 30,
              storage_read_bps: 0,
              storage_write_bps: 500,
            },
          },
        },
        {
          sampledAt: '2026-09-05T11:59:50Z',
          values: {
            owner: {
              cpu_cores: 2,
              memory_used_bytes: 2 ** 30,
              storage_read_bps: 40,
              storage_write_bps: 600,
            },
          },
        },
      ],
    }));
    const range = vi.fn();
    const view = render(
      <PeopleView
        snapshot={data}
        onSelect={vi.fn()}
        selectedPersonKey="owner:owner-test"
        onSelectedPersonChange={vi.fn()}
        loadHistory={loadHistory}
        chartWindowMs={30 * 60000}
        retentionMs={3600000}
        onChartWindowChange={range}
      />,
    );
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole('heading', { name: 'test-owner' }),
    ).toBeInTheDocument();
    expect(
      [...view.container.querySelectorAll('[data-owner-metric]')].map((panel) =>
        panel.getAttribute('data-owner-metric'),
      ),
    ).toEqual(['cpu', 'ram', 'io']);
    expect(
      screen.getAllByRole('radiogroup', { name: 'Telemetry window' }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: '5m' }));
    expect(range).toHaveBeenCalledWith(300000);
    const chart = screen.getByRole('figure', {
      name: /test-owner cpu used history/,
    });
    fireEvent.keyDown(chart, { key: 'End' });
    expect(
      screen.getByRole('button', {
        name: /Return test-owner CPU used to live values/,
      }),
    ).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(
      screen.queryByRole('button', {
        name: /Return test-owner CPU used to live values/,
      }),
    ).toBeNull();
  });

  it('keeps distinct stable owners with identical display names and joins GPU inventory by workspace reference', () => {
    const data = snapshot();
    data.workloadTelemetry!.owners.push(ownerFixture('second', 'test-owner'));
    data.attribution = {
      provider: 'kubernetes_dra',
      resolution: {
        status: 'complete',
        unresolvedAssignments: 0,
        reasonCodes: [],
        workloads: [],
      },
      status: 'available',
      assignments: [],
      workloads: data.workloadTelemetry!.owners.map(
        (owner) => owner.workspaces[0],
      ),
    };
    const people = buildPeopleAttributionView(data).people;
    expect(people).toHaveLength(2);
    expect(new Set(people.map((owner) => owner.key)).size).toBe(2);
    expect(people.every((owner) => owner.workspaces.length === 1)).toBe(true);
    data.attribution.status = 'stale';
    expect(buildPeopleAttributionView(data).people).toHaveLength(2);
  });

  it('distinguishes measured zero, partial, estimated, no data, and a disconnected snapshot', () => {
    const owner = ownerFixture();
    expect(ownerMetricState(owner, 'storage_read_bps', 'live')).toBeNull();
    expect(formatOwnerValue('storage_read_bps', 0)).toBe('0 B/s');
    owner.status = 'partial';
    owner.metrics.storage_read_bps = {
      ...owner.metrics.storage_read_bps,
      value: null,
      status: 'error',
      message: 'Partial: 1 of 2 Pod readings available',
    };
    expect(ownerMetricState(owner, 'storage_read_bps', 'live')).toBe('Partial');
    expect(ownerMetricState(owner, 'cpu_cores', 'live')).toBeNull();
    owner.metrics.cpu_cores.status = 'unsupported';
    expect(ownerMetricState(owner, 'cpu_cores', 'live')).toBe('No data');
    owner.metrics.memory_used_bytes.status = 'estimated';
    expect(ownerMetricState(owner, 'memory_used_bytes', 'live')).toBe(
      'Estimated',
    );
    expect(ownerMetricState(owner, 'memory_used_bytes', 'reconnecting')).toBe(
      'Paused',
    );
    expect(formatOwnerValue('cpu_cores', 0.00001)).toBe('<0.001 cores');
    expect(formatOwnerValue('memory_used_bytes', 1)).toBe('<0.001 GiB');
    expect(formatOwnerValue('memory_used_bytes', 1, true)).toBe('1 bytes');
  });
});
