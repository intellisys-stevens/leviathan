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
        gpu_activity: {
          value: 37,
          unit: 'percent',
          source: 'nvml',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        sm_activity: {
          value: 29,
          unit: 'percent',
          source: 'nvml',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        memory_activity: {
          value: 14,
          unit: 'percent',
          source: 'nvml',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        sm_clock: {
          value: 1410,
          unit: 'mhz',
          source: 'nvml',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        memory_clock: {
          value: 1215,
          unit: 'mhz',
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
            capacity: { vcpus: 8, ramMiB: 30_720, rootDiskGiB: 60 },
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

function jetstreamStateWithMIG(
  computeInstanceCount: number | null,
): FleetSnapshot {
  const state = structuredClone(fleetState);
  const gpu = state.platforms[1].instances[0].agent.snapshot!.gpus[0];
  gpu.migEnabled = true;
  gpu.gpuInstances =
    computeInstanceCount == null
      ? []
      : [
          {
            uuid: `${gpu.uuid}/gi/1`,
            id: 1,
            profile: '1g.10gb',
            generation: `${gpu.uuid}/gi/1@g1`,
            memory: {
              totalBytes: 10 * 1024 ** 3,
              usedBytes: 3 * 1024 ** 3,
              freeBytes: 7 * 1024 ** 3,
              source: 'nvml',
              scope: 'gpu_instance',
              sampledAt,
              status: 'available',
            },
            metrics: {
              sm_activity: {
                value: 61,
                unit: 'percent',
                source: 'nvml_gpm',
                scope: 'gpu_instance',
                sampledAt,
                status: 'available',
              },
              dram_activity: {
                value: 24,
                unit: 'percent',
                source: 'nvml_gpm',
                scope: 'gpu_instance',
                sampledAt,
                status: 'available',
              },
            },
            computeInstances: Array.from(
              { length: computeInstanceCount },
              (_, index) => ({
                uuid: `${gpu.uuid}/gi/1/ci/${index}`,
                id: index,
                profile: '1c.1g.10gb',
                generation: `${gpu.uuid}/gi/1/ci/${index}@g1`,
                memory: {
                  totalBytes: null,
                  usedBytes: null,
                  freeBytes: null,
                  source: 'nvml',
                  scope: 'gpu_instance',
                  sampledAt,
                  status: 'unsupported',
                },
                metrics: {},
              }),
            ),
          },
        ];
  return state;
}

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
    expect(document.title).toBe('Yggdrasill · Leviathan');
    expect(
      screen.getByRole('link', {
        name: 'Open Leviathan repository on GitHub',
      }),
    ).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
    expect(localStorage.getItem('leviathan.theme.v1')).toBe('dark');
    expect(localStorage.getItem(`${'mig' + 'lens'}.theme.v1`)).toBeNull();
  });

  it('uses the Yggdrasill icon only while the platform surface is mounted', () => {
    const favicon = document.createElement('link');
    favicon.setAttribute('rel', 'icon');
    favicon.setAttribute('href', '/leviathan-mark.svg');
    document.head.append(favicon);

    const { unmount } = render(<FleetApp pathname="/platforms" />);

    expect(favicon).toHaveAttribute('href', '/yggdrasill-favicon.png');
    unmount();
    expect(favicon).toHaveAttribute('href', '/leviathan-mark.svg');

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
    const gpuRegion = screen.getByRole('region', {
      name: 'GPU test instance GPU resources',
    });
    expect(gpuRegion).toHaveTextContent(
      'Static capacity: 8 vCPU · 30 GiB RAM · 60 GiB root disk',
    );
    expect(gpuRegion).toHaveTextContent('CPU and system RAM usage unavailable');

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
    const ownerCard = within(peopleView)
      .getByText('owner-a@example.test')
      .closest('[data-testid="jetstream-person-card"]');
    expect(ownerCard).not.toBeNull();
    expect(ownerCard!).toHaveTextContent(
      'Static capacity: 8 vCPU · 30 GiB RAM · 60 GiB root disk',
    );
    expect(ownerCard!).toHaveTextContent(
      'CPU and system RAM usage unavailable',
    );
    expect(localStorage.getItem('leviathan.jetstreamDashboardView.v1')).toBe(
      'people',
    );
    expect(
      localStorage.getItem(`${'mig' + 'lens'}.jetstreamDashboardView.v1`),
    ).toBeNull();
  });

  it('opens the full GPU metrics carried by a Jetstream snapshot', async () => {
    const uplinkState = structuredClone(fleetState);
    uplinkState.platforms[1].instances[0].agent.source = 'leviathan_uplink';
    mockUseFleet.mockReturnValue({
      snapshot: uplinkState,
      connection: 'live',
      error: null,
    });
    const view = render(<FleetApp pathname="/platforms/jetstream" />);

    const gpuRegion = screen.getByRole('region', {
      name: 'GPU test instance GPU resources',
    });
    expect(gpuRegion).toHaveTextContent('Leviathan uplink');
    fireEvent.click(
      within(gpuRegion).getByRole('button', {
        name: 'Open GPU 0 full GPU details',
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('GPU activity').length).toBeGreaterThan(
      0,
    );
    expect(within(dialog).getByText('37.0%')).toBeVisible();
    expect(within(dialog).getAllByText('SM activity').length).toBeGreaterThan(
      0,
    );
    expect(within(dialog).getByText('29.0%')).toBeVisible();
    expect(
      within(dialog).getAllByText('Memory activity').length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByText('14.0%')).toBeVisible();
    expect(within(dialog).getByText('1410 MHz')).toBeVisible();
    expect(within(dialog).getByText('1215 MHz')).toBeVisible();
    expect(within(dialog).getByText('2.0 GiB / 40.0 GiB')).toBeVisible();
    expect(within(dialog).getByText('Live snapshot only')).toBeVisible();
    expect(
      within(dialog).getByText(
        'This view shows the latest telemetry snapshot. Historical activity and PCIe series are not retained for this source.',
      ),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole('group', { name: 'Detail chart window' }),
    ).toBeNull();
    expect(within(dialog).queryByTestId('detail-history-chart')).toBeNull();
    expect(within(dialog).queryByTestId('detail-pcie-chart')).toBeNull();

    const updatedState = structuredClone(uplinkState);
    updatedState.sequence += 1;
    updatedState.observedAt = '2026-08-30T19:00:01Z';
    const updatedSnapshot =
      updatedState.platforms[1].instances[0].agent.snapshot!;
    updatedSnapshot.sequence += 1;
    updatedSnapshot.sampledAt = '2026-08-30T19:00:01Z';
    updatedSnapshot.gpus[0].metrics.gpu_activity.value = 63;
    mockUseFleet.mockReturnValue({
      snapshot: updatedState,
      connection: 'live',
      error: null,
    });
    view.rerender(<FleetApp pathname="/platforms/jetstream" />);

    expect(await within(dialog).findByText('63.0%')).toBeVisible();
    expect(within(dialog).queryByText('37.0%')).toBeNull();
  });

  it('opens physical GPU details when MIG is enabled with no active GI', async () => {
    const state = jetstreamStateWithMIG(null);
    mockUseFleet.mockReturnValue({
      snapshot: state,
      connection: 'live',
      error: null,
    });
    render(<FleetApp pathname="/platforms/jetstream" />);

    const gpuRegion = screen.getByRole('region', {
      name: 'GPU test instance GPU resources',
    });
    expect(gpuRegion).toHaveTextContent('No active MIG instances.');
    fireEvent.click(
      within(gpuRegion).getByRole('button', {
        name: 'Open GPU 0 physical GPU details',
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('Physical GPU').length).toBeGreaterThan(
      0,
    );
    expect(within(dialog).queryByText('Full GPU')).toBeNull();
    expect(within(dialog).getByText('37.0%')).toBeVisible();
  });

  it('exposes physical and compute details for a single-CI MIG GPU', async () => {
    const state = jetstreamStateWithMIG(1);
    mockUseFleet.mockReturnValue({
      snapshot: state,
      connection: 'live',
      error: null,
    });
    render(<FleetApp pathname="/platforms/jetstream" />);

    const gpuRegion = screen.getByRole('region', {
      name: 'GPU test instance GPU resources',
    });
    expect(
      within(gpuRegion).getByRole('button', {
        name: 'Open GPU 0 physical GPU details',
      }),
    ).toBeVisible();
    fireEvent.click(
      within(gpuRegion).getByRole('button', { name: /GI 1 \/ CI 0/u }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('GPU 0 · GI 1 · CI 0')).toBeVisible();
    expect(within(dialog).getByText('61.0%')).toBeVisible();
  });

  it('exposes each compute selection for a multi-CI MIG GPU', async () => {
    const state = jetstreamStateWithMIG(2);
    mockUseFleet.mockReturnValue({
      snapshot: state,
      connection: 'live',
      error: null,
    });
    render(<FleetApp pathname="/platforms/jetstream" />);

    const gpuRegion = screen.getByRole('region', {
      name: 'GPU test instance GPU resources',
    });
    expect(
      within(gpuRegion).getByRole('button', {
        name: 'Open GPU 0 physical GPU details',
      }),
    ).toBeVisible();
    expect(
      within(gpuRegion).getByRole('button', { name: /CI 0/u }),
    ).toBeVisible();
    fireEvent.click(within(gpuRegion).getByRole('button', { name: /CI 1/u }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('GPU 0 · GI 1 · CI 1')).toBeVisible();
    expect(
      within(dialog).getByText('GI metrics are shared by 2 CIs.'),
    ).toBeVisible();
  });

  it.each([
    ['leviathan_agent', 'Leviathan agent'],
    ['leviathan_uplink', 'Leviathan uplink'],
  ] as const)('labels the %s telemetry source', (source, label) => {
    const sourcedState = structuredClone(fleetState);
    sourcedState.platforms[1].instances[0].agent.source = source;
    mockUseFleet.mockReturnValue({
      snapshot: sourcedState,
      connection: 'live',
      error: null,
    });

    render(<FleetApp pathname="/platforms/jetstream" />);
    fireEvent.click(
      screen.getByText('Full instance inventory', { selector: 'span' }),
    );

    const table = screen.getByRole('table', { name: 'Jetstream instances' });
    expect(
      within(table).getAllByTestId('fleet-instance-row')[0],
    ).toHaveTextContent(label);
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
    const telemetry = within(gpuRegion).getByRole('region', {
      name: 'GPU 0 live telemetry',
    });
    expect(telemetry).toHaveTextContent('Memory');
    expect(telemetry).toHaveTextContent('Unavailable');
    expect(telemetry).not.toHaveTextContent('Full GPU memory:');
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
    expect(rows[0]).toHaveTextContent(
      'Static capacity: 8 vCPU · 30 GiB RAM · 60 GiB root disk',
    );
    expect(rows[0]).toHaveTextContent('CPU and system RAM usage unavailable');
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
