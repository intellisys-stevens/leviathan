import { fireEvent, render, screen, within } from '@testing-library/react';
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
  gpus: [
    {
      uuid: 'GPU-jetstream-fixture',
      index: 0,
      name: 'NVIDIA A100-SXM4-40GB',
      migEnabled: false,
      maxMigDevices: 7,
      memory: {
        totalBytes: 40 * 1024 ** 3,
        usedBytes: 2 * 1024 ** 3,
        freeBytes: 38 * 1024 ** 3,
        source: 'nvml',
        scope: 'physical_gpu',
        sampledAt,
        status: 'available',
      },
      metrics: {
        temperature: {
          value: 34,
          unit: 'celsius',
          source: 'nvml',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        power: {
          value: 45,
          unit: 'watts',
          source: 'nvml',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        power_limit: {
          value: 400,
          unit: 'watts',
          source: 'nvml',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
      },
      gpuInstances: [],
    },
  ],
  processes: [
    { pid: 101, user: 'gpu-connected-user', status: 'available' },
    { pid: 102, user: 'gpu-connected-user', status: 'available' },
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
        {
          instance: {
            uuid: '11111111-3333-4333-8444-555555555555',
            name: 'Approved without agent endpoint',
            creatorUsername: 'owner-c@example.test',
            cloudState: 'active',
          },
          managed: true,
          agentProbeEligible: false,
          policyReason: 'agent_not_configured',
          agent: { status: 'not_configured' },
        },
      ],
    },
  ],
};

describe('FleetApp', () => {
  beforeEach(() => {
    localStorage.clear();
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
      screen.getByRole('heading', { name: 'Yggdrasill' }),
    ).toBeInTheDocument();
    const overviewIcon = screen.getByTestId('yggdrasill-icon');
    expect(overviewIcon).toHaveStyle({
      backgroundImage: 'url("/yggdrasill.png")',
    });
    expect(overviewIcon).toHaveClass('bg-contain', 'bg-no-repeat');
    expect(overviewIcon).not.toHaveClass(
      'border',
      'shadow-sm',
      'rounded-xl',
      'rounded-full',
    );
    const headerIcon = screen.getByTestId('yggdrasill-header-icon');
    expect(headerIcon).toHaveClass('bg-contain', 'bg-no-repeat');
    expect(headerIcon).not.toHaveClass(
      'border',
      'shadow-sm',
      'rounded-lg',
      'rounded-full',
    );
    expect(
      screen.getByRole('link', { name: 'Open Yggdrasill overview' }),
    ).toHaveAttribute('href', '/platforms');
    const nidhoggLink = screen.getByRole('link', {
      name: 'Open Nidhogg dashboard',
    });
    expect(nidhoggLink).toHaveAttribute(
      'href',
      'https://nidhogg.example.test/',
    );
    expect(within(nidhoggLink).getByText('Access')).toBeVisible();
    expect(within(nidhoggLink).getByText('Direct')).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Open Jetstream dashboard' }),
    ).toHaveAttribute('href', '/platforms/jetstream');
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.title).toBe('Yggdrasill · MIGLens');
  });

  it('uses the Yggdrasill icon only while the platform surface is mounted', () => {
    const favicon = document.createElement('link');
    favicon.setAttribute('rel', 'icon');
    favicon.setAttribute('href', '/miglens-mark.png');
    document.head.append(favicon);

    const { unmount } = render(<FleetApp pathname="/platforms" />);

    expect(favicon).toHaveAttribute('href', '/yggdrasill-favicon.png');
    unmount();
    expect(favicon).toHaveAttribute('href', '/miglens-mark.png');

    favicon.remove();
  });

  it('uses the same GPU and People organization as the host dashboard', () => {
    render(<FleetApp pathname="/platforms/jetstream" />);

    expect(
      screen.getByRole('heading', { name: 'Jetstream Dashboard' }),
    ).toBeInTheDocument();
    expect(document.title).toBe('Jetstream · Yggdrasill');
    expect(
      screen.getByRole('status', {
        name: 'Platform connection status: Degraded',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Open Nidhogg dashboard' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'GPUs', pressed: true }),
    ).toBeInTheDocument();
    expect(screen.getByText(/NVIDIA A100-SXM4-40GB/u)).toBeInTheDocument();
    expect(screen.getByText(/GPU-connected users:/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    expect(
      screen.getByRole('button', { name: 'People', pressed: true }),
    ).toBeInTheDocument();
    const peopleView = screen.getByTestId('jetstream-people-view');
    expect(peopleView).toBeInTheDocument();
    expect(within(peopleView).getByText('owner-a@example.test')).toBeVisible();
    expect(within(peopleView).getByText('owner-c@example.test')).toBeVisible();
    expect(within(peopleView).queryByText('owner-b@example.test')).toBeNull();
    expect(within(peopleView).getByText('gpu-connected-user')).toBeVisible();
  });

  it('does not turn incomplete process inspection into a false zero-user claim', () => {
    const incompleteState = structuredClone(fleetState);
    const observation = incompleteState.platforms[1].instances[0];
    observation.agent.snapshot!.processes = [];
    observation.agent.snapshot!.diagnostics = [
      {
        code: 'gpu_process_fds',
        severity: 'warning',
        component: '/proc',
        summary: '223 processes could not be checked for GPU device access',
        status: 'permission_denied',
      },
    ];
    mockUseFleet.mockReturnValue({
      snapshot: incompleteState,
      connection: 'live',
      error: null,
    });

    render(<FleetApp pathname="/platforms/jetstream" />);

    const gpuRegion = screen.getByRole('region', {
      name: 'GPU test instance GPU resources',
    });
    expect(gpuRegion).toHaveTextContent('Processes unknown');
    expect(gpuRegion).toHaveTextContent('Unknown · inspection incomplete');
    expect(gpuRegion).toHaveTextContent(
      '223 processes could not be checked for GPU device access',
    );
    expect(gpuRegion).not.toHaveTextContent('None observed');
    expect(screen.getByText('Known GPU processes')).toBeVisible();
    expect(screen.getByText('Unknown', { selector: 'p' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'People' }));
    const peopleView = screen.getByTestId('jetstream-people-view');
    const owner = within(peopleView).getByRole('region', {
      name: 'owner-a@example.test',
    });
    expect(owner).toHaveTextContent('Unknown · inspection incomplete');
    expect(owner).not.toHaveTextContent('None observed');
  });

  it('labels Exosphere console telemetry without overstating its detail', () => {
    const consoleState = structuredClone(fleetState);
    const observation = consoleState.platforms[1].instances[0];
    observation.agent.source = 'exosphere_console';
    observation.agent.snapshot!.host.hostname = 'jetstream-console';
    observation.agent.snapshot!.processes = [];
    observation.agent.snapshot!.capabilities.proc = {
      name: '/proc',
      available: false,
      status: 'unsupported',
      message:
        'GPU-connected process inspection is unavailable from Exosphere console output.',
    };
    observation.agent.snapshot!.gpus[0].memory = {
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      source: 'synthetic',
      scope: 'physical_gpu',
      sampledAt,
      status: 'unsupported',
      message: 'GPU memory is unavailable from Exosphere console output.',
    };
    observation.agent.snapshot!.gpus[0].metrics = {
      gpu_activity: {
        value: 43,
        unit: 'percent',
        source: 'synthetic',
        scope: 'physical_gpu',
        sampledAt,
        status: 'available',
      },
      sm_activity: {
        value: 43,
        unit: 'percent',
        source: 'synthetic',
        scope: 'physical_gpu',
        sampledAt,
        status: 'available',
      },
      memory_activity: {
        value: null,
        unit: 'percent',
        source: 'synthetic',
        scope: 'physical_gpu',
        sampledAt,
        status: 'unsupported',
        message: 'GPU memory is unavailable from Exosphere console output.',
      },
    };
    observation.agent.snapshot!.diagnostics = [
      {
        code: 'console_gpu_memory',
        severity: 'warning',
        component: 'exosphere_console',
        summary: 'GPU memory is unavailable from Exosphere console output',
        status: 'unsupported',
      },
      {
        code: 'console_gpu_processes',
        severity: 'warning',
        component: 'exosphere_console',
        summary:
          'GPU-connected process inspection is unavailable from Exosphere console output',
        status: 'unsupported',
      },
    ];
    mockUseFleet.mockReturnValue({
      snapshot: consoleState,
      connection: 'live',
      error: null,
    });

    render(<FleetApp pathname="/platforms/jetstream" />);

    const gpuRegion = screen.getByRole('region', {
      name: 'GPU test instance GPU resources',
    });
    expect(gpuRegion).toHaveTextContent('Exosphere console');
    expect(gpuRegion).toHaveTextContent('Processes unavailable');
    expect(gpuRegion).toHaveTextContent('GPU-connected users: Unavailable');
    expect(gpuRegion).toHaveTextContent('Full GPU memory: — / —');
    expect(gpuRegion).toHaveTextContent(
      'GPU memory is unavailable from Exosphere console output',
    );
    expect(gpuRegion).not.toHaveTextContent('None observed');

    fireEvent.click(
      screen.getByText('Full instance inventory', { selector: 'span' }),
    );
    const table = screen.getByRole('table', { name: 'Jetstream instances' });
    const consoleRow = within(table).getAllByTestId('fleet-instance-row')[0];
    expect(consoleRow).toHaveTextContent('Exosphere console');
    expect(consoleRow).toHaveTextContent('Unavailable');
  });

  it('keeps a stale last-good snapshot visible and labels it as retained', () => {
    const staleState = structuredClone(fleetState);
    staleState.platforms[1].instances[0].agent.status = 'stale';
    mockUseFleet.mockReturnValue({
      snapshot: staleState,
      connection: 'live',
      error: null,
    });

    render(<FleetApp pathname="/platforms/jetstream" />);

    const gpuRegion = screen.getByRole('region', {
      name: 'GPU test instance GPU resources',
    });
    expect(gpuRegion).toHaveTextContent('NVIDIA A100-SXM4-40GB');
    expect(gpuRegion).toHaveTextContent('Stale');
    expect(gpuRegion).toHaveTextContent('2 processes · last known');
    expect(gpuRegion).toHaveTextContent('gpu-connected-user · last known');
    expect(gpuRegion).toHaveTextContent('last retained telemetry snapshot');
  });

  it('keeps unknown platform paths inside the platform surface', () => {
    render(<FleetApp pathname="/platforms/not-a-route" />);

    expect(
      screen.getByRole('heading', { name: 'Yggdrasill page not found' }),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Return to platform overview' }),
    ).toHaveAttribute('href', '/platforms');
    expect(
      screen.queryByRole('heading', { name: 'Jetstream Dashboard' }),
    ).toBeNull();
    expect(document.title).toBe('Yggdrasill page not found');
  });

  it('separates cloud, agent, telemetry, creator, and GPU-connected-user state', () => {
    render(<FleetApp pathname="/platforms/jetstream/" />);

    fireEvent.click(
      screen.getByText('Full instance inventory', { selector: 'span' }),
    );

    const table = screen.getByRole('table', { name: 'Jetstream instances' });
    for (const heading of [
      'Creator',
      'Cloud',
      'Telemetry source',
      'Telemetry',
      'GPU-connected users',
    ]) {
      expect(
        within(table).getByRole('columnheader', { name: heading }),
      ).toBeInTheDocument();
    }

    const rows = within(table).getAllByTestId('fleet-instance-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('owner-a@example.test');
    expect(rows[0]).toHaveTextContent('Running');
    expect(rows[0]).toHaveTextContent('Live');
    expect(rows[0]).toHaveTextContent('Degraded');
    expect(rows[0]).toHaveTextContent('gpu-connected-user');
    expect(rows[0]).toHaveTextContent('Approved test scope');
    expect(rows[1]).toHaveTextContent('owner-b@example.test');
    expect(rows[1]).toHaveTextContent('Shelved offloaded');
    expect(rows[1]).toHaveTextContent('Not monitored');
    expect(rows[1]).toHaveTextContent('Unavailable');
    expect(rows[1]).toHaveTextContent('Inventory only');
    expect(rows[2]).toHaveTextContent('owner-c@example.test');
    expect(rows[2]).toHaveTextContent('Not configured');
    expect(rows[2]).toHaveTextContent('Approved · agent not configured');
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
    render(<FleetApp pathname="/platforms/jetstream" />);

    expect(screen.queryByText('SECRET-PASSPHRASE-CANARY')).toBeNull();
    expect(screen.queryByText('SECRET-TOKEN-CANARY')).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: /unshelve|restart|install|password|passphrase/i,
      }),
    ).toBeNull();
  });
});
