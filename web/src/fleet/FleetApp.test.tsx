import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot as AgentSnapshot } from '../types';
import FleetApp from './FleetApp';
import type { FleetSnapshot } from './types';

const mockUseFleet = vi.hoisted(() => vi.fn());

vi.mock('./use-fleet', () => ({ useFleet: mockUseFleet }));

const sampledAt = '2026-08-30T19:00:00Z';
const agentSnapshot: AgentSnapshot = {
  schemaVersion: 'v1',
  sequence: 12,
  sampledAt,
  host: { hostname: 'jetstream-agent', os: 'linux', arch: 'amd64' },
  gpus: [],
  processes: [
    { pid: 101, user: 'active-user', status: 'available' },
    { pid: 102, user: 'active-user', status: 'available' },
  ],
  capabilities: {
    nvml: { name: 'NVML', available: true, status: 'available' },
    gpm: { name: 'GPM', available: false, status: 'unsupported' },
    dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
    proc: { name: '/proc', available: true, status: 'available' },
    profileMetrics: false,
  },
  diagnostics: [
    {
      code: 'fixture-warning',
      severity: 'warning',
      component: 'fixture',
      summary: 'Synthetic warning',
      status: 'stale',
    },
  ],
};

const fleetState: FleetSnapshot = {
  schemaVersion: 'fleet-v1',
  sequence: 7,
  observedAt: sampledAt,
  platforms: [
    {
      platform: {
        id: 'nidhogg',
        displayName: 'Nidhogg',
        kind: 'host',
        dashboardUrl: 'https://nidhogg.example.test/',
      },
      inventory: {
        status: 'available',
        observedAt: sampledAt,
        lastAttemptAt: sampledAt,
        lastSuccessAt: sampledAt,
      },
      instances: [],
    },
    {
      platform: {
        id: 'jetstream',
        displayName: 'Jetstream',
        kind: 'openstack',
      },
      inventory: {
        status: 'available',
        observedAt: sampledAt,
        lastAttemptAt: sampledAt,
        lastSuccessAt: sampledAt,
      },
      instances: [
        {
          instance: {
            uuid: '11111111-1111-4111-8111-111111111111',
            name: 'GPU test instance',
            creatorUsername: 'owner-a@example.test',
            cloudState: 'active',
            flavor: 'g3.medium',
          },
          managed: true,
          agentProbeEligible: true,
          policyReason: 'allowed',
          agent: {
            status: 'available',
            observedAt: sampledAt,
            snapshot: agentSnapshot,
          },
        },
        {
          instance: {
            uuid: '11111111-2222-4333-8444-555555555555',
            name: 'Inventory-only fixture',
            creatorUsername: 'owner-b@example.test',
            cloudState: 'shelved_offloaded',
          },
          managed: false,
          agentProbeEligible: false,
          policyReason: 'not_allowlisted',
          agent: { status: 'not_managed' },
        },
      ],
    },
  ],
};

describe('FleetApp', () => {
  beforeEach(() => {
    mockUseFleet.mockReset();
    mockUseFleet.mockReturnValue({
      snapshot: fleetState,
      connection: 'live',
      error: null,
    });
  });

  it('presents Nidhogg and Jetstream as peer platform links', () => {
    render(<FleetApp pathname="/fleet" />);

    expect(
      screen.getByRole('heading', { name: 'Platform overview' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open Nidhogg dashboard' }),
    ).toHaveAttribute('href', 'https://nidhogg.example.test/');
    expect(
      screen.getByRole('link', { name: 'Open Jetstream fleet dashboard' }),
    ).toHaveAttribute('href', '/fleet/jetstream');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('separates cloud, agent, telemetry, creator, and active-user state', () => {
    render(<FleetApp pathname="/fleet/jetstream" />);

    const table = screen.getByRole('table', { name: 'Jetstream instances' });
    for (const heading of [
      'Creator',
      'Cloud',
      'Agent',
      'Telemetry',
      'Active GPU users',
    ]) {
      expect(
        within(table).getByRole('columnheader', { name: heading }),
      ).toBeInTheDocument();
    }

    const rows = within(table).getAllByTestId('fleet-instance-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('owner-a@example.test');
    expect(rows[0]).toHaveTextContent('Running');
    expect(rows[0]).toHaveTextContent('Live');
    expect(rows[0]).toHaveTextContent('Degraded');
    expect(rows[0]).toHaveTextContent('active-user');
    expect(rows[0]).toHaveTextContent('Approved test scope');
    expect(rows[1]).toHaveTextContent('owner-b@example.test');
    expect(rows[1]).toHaveTextContent('Shelved offloaded');
    expect(rows[1]).toHaveTextContent('Not monitored');
    expect(rows[1]).toHaveTextContent('Unavailable');
    expect(rows[1]).toHaveTextContent('Inventory only');
  });

  it('renders only safe fleet fields and exposes no resource mutation controls', () => {
    const unsafeFixture = {
      ...fleetState,
      password: 'SECRET-PASSPHRASE-CANARY',
      token: 'SECRET-TOKEN-CANARY',
    } as FleetSnapshot;
    mockUseFleet.mockReturnValue({
      snapshot: unsafeFixture,
      connection: 'live',
      error: null,
    });
    render(<FleetApp pathname="/fleet/jetstream" />);

    expect(screen.queryByText('SECRET-PASSPHRASE-CANARY')).toBeNull();
    expect(screen.queryByText('SECRET-TOKEN-CANARY')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: /unshelve|restart|install|password|passphrase/i,
      }),
    ).toBeNull();
  });
});
