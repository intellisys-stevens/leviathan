import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  App,
  DetailSheetFallback,
  formatBuildVersion,
  operationsFocusForHash,
  parseWorkbenchHash,
  resolveInitialWorkbenchView,
} from './App';
import { clearWorkloadHistoryCache } from './components/workload-telemetry-chart';
import type {
  Attribution,
  Capabilities,
  Diagnostic,
  GPU,
  Process,
  RuntimeSettings,
  Snapshot,
} from './types';
import { systemCapability, systemFixture } from './test/system-fixture';

const mockUseLeviathan = vi.hoisted(() => vi.fn());
const scrollIntoViewMock = vi.fn();

vi.mock('./use-leviathan', () => ({ useLeviathan: mockUseLeviathan }));

const sampledAt = '2026-08-29T12:00:00Z';
const available = {
  name: 'fixture',
  available: true,
  status: 'available' as const,
};
const unavailable = {
  name: 'unused',
  available: false,
  status: 'unsupported' as const,
};
const capabilities: Capabilities = {
  system: systemCapability,
  nvml: available,
  gpm: available,
  dcgm: unavailable,
  proc: {
    ...available,
    name: '/proc GPU clients (current PID namespace)',
    message: '1 GPU-connected process visible in the current PID namespace',
  },
  profileMetrics: true,
};

const processes: Process[] = [
  {
    pid: 4100,
    user: 'research',
    executable: '/usr/bin/python3',
    commandLine: 'python3 train.py --epochs 20',
    startTime: sampledAt,
    status: 'available',
  },
];

function populatedGPU(index = 0): GPU {
  const gpuUUID = `GPU-fixture-${index}`;
  return {
    uuid: gpuUUID,
    index,
    name: 'NVIDIA Blackwell fixture',
    migEnabled: true,
    maxMigDevices: 1,
    memory: {
      totalBytes: 103_079_215_104,
      usedBytes: 10_737_418_240,
      freeBytes: 92_341_796_864,
      source: 'nvml',
      scope: 'physical_gpu',
      sampledAt,
      status: 'available',
    },
    metrics: {
      temperature: {
        value: 48,
        unit: 'celsius',
        source: 'nvml',
        scope: 'physical_gpu',
        sampledAt,
        status: 'available',
      },
      power: {
        value: 142,
        unit: 'watts',
        source: 'nvml',
        scope: 'physical_gpu',
        sampledAt,
        status: 'available',
      },
      power_limit: {
        value: 250,
        unit: 'watts',
        source: 'nvml',
        scope: 'physical_gpu',
        sampledAt,
        status: 'available',
      },
      pcie_rx_bytes_per_second: {
        value: 1_073_741_824,
        unit: 'bytes_per_second',
        source: 'nvml',
        scope: 'physical_gpu',
        sampledAt,
        status: 'available',
      },
      pcie_tx_bytes_per_second: {
        value: 536_870_912,
        unit: 'bytes_per_second',
        source: 'nvml',
        scope: 'physical_gpu',
        sampledAt,
        status: 'available',
      },
    },
    gpuInstances: [
      {
        uuid: `${gpuUUID}/gi/1`,
        id: 1,
        profile: '1g.24gb',
        generation: `${gpuUUID}/gi/1@g1`,
        memory: {
          totalBytes: 25_769_803_776,
          usedBytes: 5_368_709_120,
          freeBytes: 20_401_094_656,
          source: 'nvml',
          scope: 'gpu_instance',
          sampledAt,
          status: 'available',
        },
        metrics: {
          gpu_activity: {
            value: 72,
            unit: 'percent',
            source: 'nvml_gpm',
            scope: 'gpu_instance',
            sampledAt,
            status: 'available',
          },
          sm_activity: {
            value: 68,
            unit: 'percent',
            source: 'nvml_gpm',
            scope: 'gpu_instance',
            sampledAt,
            status: 'available',
          },
          dram_activity: {
            value: 54,
            unit: 'percent',
            source: 'nvml_gpm',
            scope: 'gpu_instance',
            sampledAt,
            status: 'available',
          },
        },
        computeInstances: [
          {
            uuid: `MIG-fixture-${index}-0`,
            id: 0,
            profile: '1c.1g.24gb',
            generation: `MIG-fixture-${index}-0@g1`,
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
          },
        ],
      },
    ],
  };
}

function GPUWithoutMetrics(): GPU {
  const gpu = populatedGPU();
  gpu.metrics.temperature = {
    ...gpu.metrics.temperature,
    value: null,
    status: 'unsupported',
  };
  gpu.memory = {
    ...gpu.memory,
    totalBytes: null,
    usedBytes: null,
    freeBytes: null,
    status: 'unsupported',
  };
  const gi = gpu.gpuInstances[0];
  gi.metrics.gpu_activity = {
    ...gi.metrics.gpu_activity,
    value: null,
    status: 'unsupported',
  };
  gi.metrics.sm_activity = {
    ...gi.metrics.sm_activity,
    value: null,
    status: 'unsupported',
  };
  gi.metrics.dram_activity = {
    ...gi.metrics.dram_activity,
    value: null,
    status: 'unsupported',
  };
  gpu.metrics.pcie_rx_bytes_per_second = {
    ...gpu.metrics.pcie_rx_bytes_per_second,
    value: null,
    status: 'unsupported',
  };
  gpu.metrics.pcie_tx_bytes_per_second = {
    ...gpu.metrics.pcie_tx_bytes_per_second,
    value: null,
    status: 'unsupported',
  };
  gi.memory = {
    ...gi.memory,
    totalBytes: null,
    usedBytes: null,
    freeBytes: null,
    status: 'unsupported',
  };
  return gpu;
}

function fullGPU(index = 2): GPU {
  const gpu = populatedGPU(index);
  gpu.name = 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition';
  gpu.pciBusId = '0000:42:00.0';
  gpu.migEnabled = false;
  gpu.maxMigDevices = 0;
  gpu.gpuInstances = [];
  gpu.metrics = {
    temperature: {
      ...gpu.metrics.temperature,
      value: 82,
    },
    power: {
      ...gpu.metrics.power,
      value: 300,
    },
    power_limit: {
      ...gpu.metrics.power_limit,
      value: 300,
    },
    pcie_rx_bytes_per_second: {
      ...gpu.metrics.pcie_rx_bytes_per_second,
      value: 2_147_483_648,
    },
    pcie_tx_bytes_per_second: {
      ...gpu.metrics.pcie_tx_bytes_per_second,
      value: 1_073_741_824,
    },
    gpu_activity: {
      value: 100,
      unit: 'percent',
      source: 'nvml',
      scope: 'physical_gpu',
      sampledAt,
      status: 'available',
    },
    sm_activity: {
      value: 98.4,
      unit: 'percent',
      source: 'nvml',
      scope: 'physical_gpu',
      sampledAt,
      status: 'available',
    },
    memory_activity: {
      value: 89,
      unit: 'percent',
      source: 'nvml',
      scope: 'physical_gpu',
      sampledAt,
      status: 'available',
    },
    sm_clock: {
      value: 1807,
      unit: 'mhz',
      source: 'nvml',
      scope: 'physical_gpu',
      sampledAt,
      status: 'available',
    },
    memory_clock: {
      value: 13365,
      unit: 'mhz',
      source: 'nvml',
      scope: 'physical_gpu',
      sampledAt,
      status: 'available',
    },
  };
  return gpu;
}

function snapshot(
  gpus: GPU[] = [populatedGPU()],
  diagnostics: Diagnostic[] = [],
  gpuProcesses: Process[] = processes,
): Snapshot {
  return {
    schemaVersion: 'v1',
    sequence: 12,
    sampledAt,
    host: { hostname: 'fixture-host', os: 'linux', arch: 'amd64' },
    system: systemFixture(sampledAt),
    gpus,
    processes: gpuProcesses,
    capabilities,
    diagnostics,
  };
}

const workspaceAttribution: Attribution = {
  provider: 'coder-kubernetes',
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
      ref: 'internal-workload-ref',
      platform: 'coder',
      kind: 'workspace',
      name: 'training-lab',
      ownerName: 'alice',
    },
  ],
  assignments: [
    {
      workloadRef: 'internal-workload-ref',
      entityType: 'compute_instance',
      entityUuid: 'MIG-fixture-0-0',
      state: 'allocated',
    },
  ],
};

function result(
  current: Snapshot | null,
  connection = 'live',
  error: string | null = null,
  settings: RuntimeSettings = {
    samplingIntervalMs: 500,
    profileIntervalMs: 1000,
    processIntervalMs: 1000,
    historyWindowMs: 60 * 60 * 1000,
    allowedSamplingIntervalsMs: [500, 1000, 2000],
  },
) {
  const historyValues = {
    temperature: 47,
    gpu_activity: 61,
    sm_activity: 60,
    memory_activity: 32,
    dram_activity: 31,
    pcie_rx_bytes_per_second: 1_073_741_824,
    pcie_tx_bytes_per_second: 536_870_912,
    memory_used_bytes: 4_294_967_296,
    memory_total_bytes: 25_769_803_776,
  };
  return {
    snapshot: current,
    connection,
    error,
    history: vi.fn(async (entity: string, metrics: string[]) => ({
      entity,
      metrics,
      window: '30m0s',
      points: [
        {
          sampledAt: '2026-08-29T11:59:59Z',
          values: historyValues,
        },
      ],
    })),
    alignedHistory: vi.fn(
      async (request: {
        window: string;
        maxPoints: number;
        series: Array<{ key: string; entity: string; metrics: string[] }>;
      }) => ({
        window: request.window,
        series: request.series,
        points: [
          {
            sampledAt: '2026-08-29T11:59:59Z',
            values: Object.fromEntries(
              request.series.map((series) => [
                series.key,
                Object.fromEntries(
                  series.metrics.flatMap((metric) =>
                    metric in historyValues
                      ? [
                          [
                            metric,
                            historyValues[metric as keyof typeof historyValues],
                          ],
                        ]
                      : [],
                  ),
                ),
              ]),
            ),
          },
        ],
      }),
    ),
    settings,
    buildInfo: {
      version: '0.1.0',
      commit: 'abc1234',
      buildDate: '2026-08-30T12:00:00Z',
    },
    updateSamplingInterval: vi.fn(async (samplingIntervalMs: number) => ({
      ...settings,
      samplingIntervalMs,
    })),
  };
}

describe('Leviathan dashboard states', () => {
  beforeEach(() => {
    mockUseLeviathan.mockReset();
    clearWorkloadHistoryCache();
    scrollIntoViewMock.mockClear();
    localStorage.clear();
    window.history.replaceState(null, '', '#overview');
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });
    Object.defineProperty(window.history, 'scrollRestoration', {
      configurable: true,
      writable: true,
      value: 'auto',
    });
  });

  function openView(name: string) {
    fireEvent.click(screen.getByRole('link', { name: new RegExp(`^${name}`) }));
  }

  it('uses the managed modal sheet for lazy detail loading', async () => {
    const onOpenChange = vi.fn();
    render(<DetailSheetFallback open onOpenChange={onOpenChange} />);

    const dialog = screen.getByRole('dialog', {
      name: 'Loading resource details',
    });
    expect(dialog).toHaveAttribute('data-testid', 'detail-sheet-fallback');
    expect(dialog).toHaveClass('detail-sheet-surface');
    expect(
      document.querySelector('[data-slot="sheet-overlay"]'),
    ).not.toBeNull();

    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.click(close);
    await waitFor(() =>
      expect(onOpenChange.mock.calls.some(([open]) => open === false)).toBe(
        true,
      ),
    );
  });

  it('formats release, prefixed, development, loading, and unavailable versions', () => {
    expect(
      formatBuildVersion({ version: '0.1.0', commit: '', buildDate: '' }),
    ).toBe('v0.1.0');
    expect(
      formatBuildVersion({ version: 'v2.3.4', commit: '', buildDate: '' }),
    ).toBe('v2.3.4');
    expect(
      formatBuildVersion({ version: 'dev', commit: '', buildDate: '' }),
    ).toBe('dev');
    expect(formatBuildVersion(undefined)).toBe('…');
    expect(formatBuildVersion(null)).toBe('unavailable');
  });

  it('normalizes canonical hashes and migrates the legacy perspective once', () => {
    expect(parseWorkbenchHash('#resources')).toBe('resources');
    expect(parseWorkbenchHash('#operations')).toBe('status');
    expect(parseWorkbenchHash('#processes')).toBe('workloads');
    expect(parseWorkbenchHash('#diagnostics')).toBe('status');
    expect(operationsFocusForHash('#processes')).toBe('processes');
    expect(operationsFocusForHash('#diagnostics')).toBeNull();
    expect(operationsFocusForHash('#operations')).toBeNull();
    expect(parseWorkbenchHash('#Resources')).toBeNull();
    expect(resolveInitialWorkbenchView('#unknown', 'people')).toBe('overview');
    expect(resolveInitialWorkbenchView('', 'people')).toBe('workloads');
    expect(resolveInitialWorkbenchView('', 'gpus')).toBe('resources');
    expect(resolveInitialWorkbenchView('', null)).toBe('overview');
  });

  it('consumes the old GPU/People preference only when no hash exists', () => {
    window.history.replaceState(null, '', window.location.pathname);
    window.localStorage.setItem('leviathan.dashboardView.v1', 'people');
    mockUseLeviathan.mockReturnValue(result(snapshot()));

    render(<App />);

    expect(window.location.hash).toBe('#workloads');
    expect(
      window.localStorage.getItem('leviathan.dashboardView.v1'),
    ).toBeNull();
  });

  it('treats a trailing empty fragment as an overview fallback', () => {
    window.history.replaceState(null, '', `${window.location.pathname}#`);
    window.localStorage.setItem('leviathan.dashboardView.v1', 'people');
    mockUseLeviathan.mockReturnValue(result(snapshot()));

    render(<App />);

    expect(window.location.hash).toBe('#overview');
    expect(
      screen.getByRole('heading', { name: 'Overview', level: 1 }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem('leviathan.dashboardView.v1')).toBe(
      'people',
    );
  });

  it('lands canonical navigation and fallback hashes at the top', async () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);
    const scrollTo = vi.mocked(window.scrollTo);

    openView('Resources');
    await waitFor(() =>
      expect(scrollTo).toHaveBeenLastCalledWith({
        top: 0,
        left: 0,
        behavior: 'auto',
      }),
    );
    expect(
      screen.getByRole('heading', { name: 'Resources', level: 1 }),
    ).toHaveFocus();

    scrollTo.mockClear();
    openView('Overview');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledOnce());
    openView('Overview');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(2));

    scrollTo.mockClear();
    window.history.replaceState(null, '', '#unknown');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('#overview');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledOnce());

    scrollTo.mockClear();
    window.history.replaceState(null, '', `${window.location.pathname}#`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('#overview');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledOnce());
  });

  it('resets canonical direct loads to the top without stealing focus', async () => {
    window.history.replaceState(null, '', '#resources');
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);

    await waitFor(() =>
      expect(window.scrollTo).toHaveBeenCalledWith({
        top: 0,
        left: 0,
        behavior: 'auto',
      }),
    );
    expect(
      screen.getByRole('heading', { name: 'Resources', level: 1 }),
    ).not.toHaveFocus();
  });

  it('supports deep links, canonical fallback, and focused hash navigation', async () => {
    window.history.replaceState(null, '', '#unknown');
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    const invalid = render(<App />);
    expect(window.location.hash).toBe('#overview');
    invalid.unmount();

    window.history.replaceState(null, '', '#processes');
    render(<App />);
    expect(window.location.hash).toBe('#workloads');
    expect(
      screen.getByRole('heading', { name: 'Workloads', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('process-section')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Workloads', level: 1 }),
      ).toHaveFocus(),
    );
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'start',
      behavior: 'auto',
    });

    window.history.replaceState(null, '', '#diagnostics');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('#status');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Status' })).toHaveFocus(),
    );

    window.history.replaceState(null, '', '#processes');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('#workloads');
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Workloads', level: 1 }),
      ).toHaveFocus(),
    );

    openView('Resources');
    expect(window.location.hash).toBe('#resources');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Resources' })).toHaveFocus(),
    );

    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe('#workloads'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Workloads' })).toHaveFocus(),
    );
  });

  it('waits for an open detail sheet to close before focusing a hash destination', async () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);
    openView('Resources');
    fireEvent.click(
      screen.getByRole('button', {
        name: /Open GPU 0 · GI 1 · CI 0 details/u,
      }),
    );
    await screen.findByRole('dialog', { name: 'GPU 0 · GI 1 · CI 0' });

    window.history.replaceState(null, '', '#operations');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Status' })).toHaveFocus(),
    );
  });

  it('releases detail focus state when the selected resource disappears', async () => {
    let current = snapshot();
    const dashboard = result(current);
    mockUseLeviathan.mockImplementation(() => ({
      ...dashboard,
      snapshot: current,
    }));
    const view = render(<App />);
    openView('Resources');
    fireEvent.click(
      screen.getByRole('button', {
        name: /Open GPU 0 · GI 1 · CI 0 details/u,
      }),
    );
    await screen.findByRole('dialog', { name: 'GPU 0 · GI 1 · CI 0' });

    current = snapshot([]);
    view.rerender(<App />);
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Resources', level: 1 }),
      ).toHaveFocus(),
    );

    openView('Status');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Status' })).toHaveFocus(),
    );
  });

  it('preserves modified-link behavior and owns scroll restoration while mounted', () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    const view = render(<App />);
    expect(window.history.scrollRestoration).toBe('manual');
    const resources = screen.getByRole('link', { name: /^Resources/ });
    expect(fireEvent.click(resources, { ctrlKey: true })).toBe(true);
    expect(window.location.hash).toBe('#overview');

    view.unmount();
    expect(window.history.scrollRestoration).toBe('auto');
  });

  it('renders the loading state and focuses its active heading on navigation', async () => {
    mockUseLeviathan.mockReturnValue(result(null, 'connecting'));
    render(<App />);
    expect(screen.getByLabelText('Loading overview view')).toBeInTheDocument();
    openView('Resources');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Resources' })).toHaveFocus(),
    );
  });

  it('does not claim retained data while waiting for the first snapshot', () => {
    mockUseLeviathan.mockReturnValue(result(null, 'connecting'));
    render(<App />);
    const health = screen.getByRole('region', { name: 'Active host health' });
    expect(health).toHaveTextContent('Connecting to this host…');
    expect(health).not.toHaveTextContent(/last (complete )?snapshot|retained/i);
    expect(screen.getByLabelText('Loading overview view')).toBeInTheDocument();
  });

  it('uses one fixed four-tab workbench navigator on mobile', async () => {
    const originalMatchMedia = window.matchMedia;
    const mediaQuery = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true,
      }) as unknown as MediaQueryList;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(mediaQuery),
    });
    const diagnostic: Diagnostic = {
      code: 'gpu_process_fields',
      severity: 'warning',
      component: '/proc/10',
      summary: 'GPU process records are incomplete',
      detail: 'Permission denied',
      status: 'permission_denied',
    };
    mockUseLeviathan.mockReturnValue(
      result(snapshot([populatedGPU()], [diagnostic])),
    );

    const view = render(<App />);
    try {
      const navigation = screen.getByRole('navigation', {
        name: 'Mobile workbench views',
      });
      expect(navigation).toHaveClass(
        'mobile-workbench-nav',
        'fixed',
        'bottom-0',
      );
      expect(
        screen.queryByRole('navigation', { name: 'Workbench views' }),
      ).toBeNull();
      expect(within(navigation).getAllByRole('link')).toHaveLength(4);
      for (const link of within(navigation).getAllByRole('link')) {
        expect(link).toHaveClass('flowing-surface');
        expect(
          link.querySelector(':scope > [data-slot="perimeter-light"]'),
        ).toHaveAttribute('aria-hidden', 'true');
      }
      expect(
        within(navigation).getByRole('link', { name: 'Overview' }),
      ).toHaveAttribute('aria-current', 'page');
      expect(
        within(navigation).getByRole('link', {
          name: /Status.*1 active diagnostics/u,
        }),
      ).toContainElement(navigation.querySelector('.mobile-diagnostic-count'));

      fireEvent.click(
        within(navigation).getByRole('link', { name: 'Resources' }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: 'Resources' }),
        ).toHaveFocus(),
      );
    } finally {
      view.unmount();
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it('uses only Leviathan browser state keys without migrating legacy state', async () => {
    localStorage.setItem('miglens.theme.v1', 'light');
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);

    expect(screen.getByText('Leviathan', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('MIGLens', { exact: true })).toBeNull();
    const themeToggle = screen.getByRole('button', { name: 'Use light theme' });
    fireEvent.click(themeToggle);

    await waitFor(() =>
      expect(localStorage.getItem('leviathan.theme.v1')).toBe('light'),
    );
    expect(localStorage.getItem('miglens.theme.v1')).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('omits the Processes panel while keeping GPU discovery states', () => {
    mockUseLeviathan.mockReturnValue(result(snapshot([])));
    render(<App />);
    openView('Resources');
    expect(screen.getByText('No NVIDIA GPUs detected')).toBeInTheDocument();
    openView('Workloads');
    expect(screen.queryByTestId('process-section')).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Filter GPU processes'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('4100')).not.toBeInTheDocument();
  });

  it('shows hardware capacity and routes to a resource section without duplicated attribution', async () => {
    mockUseLeviathan.mockReturnValue(
      result({
        ...snapshot([populatedGPU(0), fullGPU(2)]),
        attribution: workspaceAttribution,
      }),
    );
    render(<App />);
    expect(
      screen.queryByRole('button', { name: /Assignment integration/ }),
    ).toBeNull();
    const tiles = document.querySelectorAll('.host-capacity-card');
    expect(tiles).toHaveLength(4);
    fireEvent.click(tiles[2]);
    await waitFor(() => expect(window.location.hash).toBe('#resources'));
    expect(
      document.querySelectorAll('.gpu-resource-grid .gpu-card'),
    ).toHaveLength(2);
    expect(
      screen.queryByRole('group', { name: 'GPU resource filter' }),
    ).toBeNull();
    expect(screen.queryByText('Observed workspace assignments')).toBeNull();
    openView('Workloads');
    expect(
      screen.getAllByRole('button', {
        name: 'Assignment integration: Connected',
      }),
    ).toHaveLength(1);
    expect(screen.queryByTestId('process-section')).not.toBeInTheDocument();
  });

  it('selects motherboard resources from capacity tiles and retains selection across views', async () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect RAM resources' }),
    );
    await waitFor(() => expect(window.location.hash).toBe('#resources'));
    const memory = document.getElementById('resource-memory')!;
    await waitFor(() => expect(memory).toHaveFocus());
    expect(memory).toHaveAttribute('aria-pressed', 'true');
    expect(document.getElementById('resource-cpu')).toBeInTheDocument();
    expect(document.getElementById('resource-storage')).toBeInTheDocument();
    openView('Workloads');
    openView('Resources');
    expect(document.getElementById('resource-memory')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    openView('Overview');
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect Storage resources' }),
    );
    await waitFor(() =>
      expect(document.getElementById('resource-storage')).toHaveFocus(),
    );
    expect(document.getElementById('resource-storage')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows every applicable Overview chart without expansion in resource order', async () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);
    await screen.findByTestId('temperature-chart');
    expect(
      screen.queryByRole('button', { name: /^GPU details/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Inspect history')).not.toBeInTheDocument();
    const headings = [
      ...document.querySelectorAll('.overview-chart-grid h3'),
    ].map((node) => node.textContent);
    expect(headings.slice(0, 2)).toEqual(['CPU', 'RAM']);
    expect(headings.at(-1)).toBe('Storage');
    expect(screen.getByTestId('gpu-activity-chart')).toBeInTheDocument();
  });

  it('keeps the last snapshot visible while disconnected', () => {
    mockUseLeviathan.mockReturnValue(
      result(snapshot(), 'reconnecting', 'stream closed'),
    );
    render(<App />);
    expect(screen.getByText(/Live stream reconnecting/)).toBeInTheDocument();
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    expect(screen.queryByText(/#12/)).not.toBeInTheDocument();
    openView('Resources');
    expect(screen.getByText('GPU 0')).toBeInTheDocument();
  });

  it('scopes a failed snapshot refresh while retaining the last complete data', () => {
    const retrySnapshot = vi.fn();
    mockUseLeviathan.mockReturnValue({
      ...result(snapshot()),
      snapshotError: 'Snapshot request failed (503)',
      retrySnapshot,
    });
    render(<App />);

    expect(
      screen.getByText(
        'Snapshot request failed (503) The last complete snapshot remains visible.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry snapshot' }));
    expect(retrySnapshot).toHaveBeenCalledOnce();
  });

  it('uses a fixed half-second cadence throughout dashboard navigation', () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);
    for (const view of ['Overview', 'Resources', 'Workloads', 'Status']) {
      openView(view);
      expect(mockUseLeviathan).toHaveBeenLastCalledWith(500);
      const status = screen.getByTestId('desktop-live-sampling');
      expect(within(status).getByText('Live')).toBeInTheDocument();
      expect(
        within(status).getByLabelText('View updates every 0.5s'),
      ).toHaveTextContent('0.5s');
      expect(
        screen.queryByRole('radiogroup', { name: 'View updates' }),
      ).toBeNull();
    }
  });

  it('opens and dismisses the accessible mobile view-update popover', async () => {
    const dashboard = result(snapshot());
    mockUseLeviathan.mockReturnValue(dashboard);
    render(<App />);

    const trigger = screen.getByRole('button', {
      name: 'Live status, view updates 0.5s',
    });
    fireEvent.click(trigger);
    const popup = await screen.findByRole('dialog');
    expect(
      within(popup).queryByText(
        /This browser updates|Host samples|profiles|processes/,
      ),
    ).toBeNull();
    expect(within(popup).getByText('View updates')).toBeVisible();

    expect(within(popup).queryByRole('radiogroup')).toBeNull();
    expect(mockUseLeviathan).toHaveBeenLastCalledWith(500);
    expect(dashboard.updateSamplingInterval).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('renders and groups explicit diagnostics', () => {
    const repeated = (component: string): Diagnostic => ({
      code: 'gpu_process_fields',
      severity: 'warning',
      component,
      summary: 'GPU process records are incomplete',
      detail: 'Permission denied',
      remedy: 'Run Leviathan as the workspace user.',
      status: 'permission_denied',
    });
    mockUseLeviathan.mockReturnValue(
      result(
        snapshot(
          [populatedGPU()],
          [repeated('/proc/10'), repeated('/proc/11')],
        ),
      ),
    );
    render(<App />);
    openView('Status');
    expect(
      screen.getAllByText('GPU process records are incomplete'),
    ).toHaveLength(1);
    expect(screen.getByText(/2 affected entities/)).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('keeps informational diagnostics neutral without degrading host status', () => {
    const informational: Diagnostic = {
      code: 'provider_ready',
      severity: 'info',
      component: 'system',
      summary: 'Host telemetry is available',
      status: 'available',
    };
    mockUseLeviathan.mockReturnValue(
      result(snapshot([populatedGPU()], [informational])),
    );
    render(<App />);
    expect(
      screen.queryByRole('region', { name: 'Active host health' }),
    ).toBeNull();
    expect(
      screen.getByLabelText('Connection status: Live'),
    ).toBeInTheDocument();
    const navigation = screen.getByRole('link', {
      name: 'Status',
    });
    expect(navigation.querySelector('.diagnostic-count')).toBeNull();
    fireEvent.click(navigation);
    const details = screen.getByRole('region', { name: 'Diagnostic details' });
    expect(
      within(details).getByText('Host telemetry is available'),
    ).toBeInTheDocument();
    expect(within(details).getByText('available')).toHaveClass(
      'text-muted-foreground',
    );
    expect(details.querySelector('svg.lucide-info')).toHaveClass(
      'text-muted-foreground',
    );
    expect(
      details.querySelector('.text-amber-700, .text-destructive'),
    ).toBeNull();
  });

  it('restores the persisted People perspective when attribution is configured', () => {
    window.history.replaceState(null, '', window.location.pathname);
    localStorage.setItem('leviathan.dashboardView.v1', 'people');
    const current = snapshot();
    current.attribution = workspaceAttribution;
    mockUseLeviathan.mockReturnValue(result(current));

    render(<App />);

    expect(window.location.hash).toBe('#workloads');
    expect(
      screen.getByRole('heading', { name: 'Workloads' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('people-view')).toBeInTheDocument();
    expect(screen.getByText('training-lab')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'GPUs' }),
    ).not.toBeInTheDocument();
  });

  it('shows an explicit unconfigured state for bare-metal workloads', () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);
    openView('Resources');
    expect(screen.getByRole('region', { name: 'GPUs' })).toBeInTheDocument();
    openView('Workloads');
    expect(
      screen.getByText('Workspace attribution is not configured'),
    ).toBeInTheDocument();
  });

  it('uses an equal-height two-column GPU grid at the desktop breakpoint', () => {
    mockUseLeviathan.mockReturnValue(
      result(snapshot([populatedGPU(0), populatedGPU(1), fullGPU(2)])),
    );
    render(<App />);
    openView('Resources');

    const topology = screen
      .getByRole('region', { name: 'GPUs' })
      .querySelector('.gpu-resource-grid');
    expect(topology).not.toBeNull();
    expect(topology).toHaveClass(
      'grid',
      'grid-cols-1',
      'items-stretch',
      'lg:grid-cols-2',
    );
    expect(topology?.querySelectorAll('.gpu-card')).toHaveLength(3);
    for (const card of topology?.querySelectorAll('.gpu-card') ?? []) {
      expect(card.parentElement).toBe(topology);
    }
    for (const progress of screen.getAllByRole('progressbar')) {
      expect(progress.closest('button')).toBeNull();
    }
  });

  it('uses AA-safe semantic temperature and power colors based on physical limits', () => {
    const warning = populatedGPU(1);
    warning.metrics.temperature = {
      ...warning.metrics.temperature,
      value: 75,
    };
    warning.metrics.power = {
      ...warning.metrics.power,
      value: 175,
    };
    mockUseLeviathan.mockReturnValue(
      result(snapshot([populatedGPU(), warning, fullGPU()])),
    );
    render(<App />);
    openView('Resources');

    expect(screen.getByTitle('Physical GPU temperature · cool')).toHaveClass(
      'text-sky-700',
      'dark:text-sky-300',
    );
    expect(
      screen.getByTitle('Physical GPU power · 57% of power limit, normal'),
    ).toHaveClass('text-primary');
    expect(screen.getByTitle('Physical GPU temperature · hot')).toHaveClass(
      'text-destructive',
    );
    expect(screen.getByTitle('Physical GPU temperature · warm')).toHaveClass(
      'text-amber-700',
      'dark:text-amber-300',
    );
    expect(
      screen.getByTitle('Physical GPU power · 70% of power limit, high'),
    ).toHaveClass('text-amber-700', 'dark:text-amber-300');
    expect(
      screen.getByTitle('Physical GPU power · 100% of power limit, near limit'),
    ).toHaveClass('text-orange-700', 'dark:text-orange-200');
  });

  it('shows workspace attribution without exposing internal join refs', async () => {
    const current = snapshot();
    current.attribution = workspaceAttribution;
    current.processes = [
      {
        ...current.processes[0],
        workloadRef: 'internal-workload-ref',
      } as Process,
    ];
    mockUseLeviathan.mockReturnValue(result(current));
    render(<App />);

    openView('Workloads');
    const attributionTrigger = screen.getByRole('button', {
      name: 'Assignment integration: Connected',
    });
    fireEvent.click(attributionTrigger);
    expect(await screen.findByText('coder-kubernetes')).toBeInTheDocument();
    expect(screen.queryByText('internal-workload-ref')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('columnheader', { name: 'Workspace' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('internal-workload-ref')).not.toBeInTheDocument();

    openView('Resources');
    fireEvent.click(screen.getByRole('button', { name: /GI 1 · CI 0/ }));
    const dialog = await screen.findByTestId('detail-sheet');
    expect(
      within(dialog).getByRole('heading', { name: 'Workspace attribution' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('alice / training-lab'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('coder · workspace')).toBeInTheDocument();
    expect(dialog.querySelector('time')).toHaveAttribute('datetime', sampledAt);
    expect(within(dialog).queryByText('internal-workload-ref')).toBeNull();
    expect(dialog).not.toHaveTextContent('MIG-fixture-0-0');
    expect(dialog).not.toHaveTextContent('GPU-fixture-0');
  });

  it('renders all five overview chart panels with scoped series labels', async () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);
    for (const name of [
      'GPU temperature',
      'GPU compute',
      'GPU memory',
      'GPU memory activity',
      'GPU transfers',
    ]) {
      expect(await screen.findByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByText('GPU 0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('GPU 0 · GI 1').length).toBeGreaterThan(0);
    expect(
      screen.getByTestId('memory-chart').closest('.overview-chart-grid'),
    ).not.toBeNull();
    expect(screen.queryByTestId('process-section')).toBeNull();
    await waitFor(() => {
      const wrapper = document.querySelector<HTMLElement>(
        '.recharts-tooltip-wrapper',
      );
      expect(wrapper?.style.zIndex).toBe('80');
      expect(wrapper?.style.position).toBe('fixed');
      expect(wrapper?.style.transform).toBe('none');
      expect(wrapper?.style.pointerEvents).toBe('none');
    });
    for (const panelID of [
      'utilization-chart',
      'memory-chart',
      'memory-activity-chart',
    ]) {
      const panel = screen.getByTestId(panelID);
      for (const tick of ['0%', '25%', '50%', '75%', '100%']) {
        expect(within(panel).getByText(tick)).toBeInTheDocument();
      }
      expect(panel).not.toHaveTextContent(/(?:^-0|99964|\.\d{4,}%)/u);
    }
  });

  it('uses concise dashboard copy', async () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'Overview' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', {
        name: /^(?:GPU overview|GPU partition overview)$/u,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Host command center.')).toBeNull();
    expect(screen.queryByText(/host \/ fixture-host/i)).toBeNull();
    expect(screen.queryByText(/CUDA client/)).toBeNull();
    expect(document.getElementById('process-table-description')).toBeNull();
    expect(screen.queryByText(/current PID namespace/)).toBeNull();
    expect(screen.queryByText(/not workspace-attributed/)).toBeNull();
    expect(
      screen.queryByText('Unavailable metrics and provider issues.'),
    ).toBeNull();
    const footer = screen.getByRole('contentinfo');
    const desktopFooter = footer.querySelector('.desktop-footer-copy');
    const mobileFooter = footer.querySelector('.mobile-footer-copy');
    expect(desktopFooter).toHaveTextContent(
      'Built with ⚔️ by Intellisys Dragoons and Codex · Leviathan v0.1.0',
    );
    expect(mobileFooter).toHaveTextContent(
      '⚔️ Intellisys Dragoons × Codex Leviathan v0.1.0',
    );
    expect(mobileFooter).toHaveClass('mobile-footer-copy');
    expect(mobileFooter?.querySelector('a')).toHaveAttribute(
      'href',
      'https://intellisys.haow.us/team/',
    );
    expect(
      screen.getAllByRole('link', { name: 'Intellisys Dragoons' }),
    ).toHaveLength(2);
    expect(footer).not.toHaveTextContent('linux/amd64');
    expect(footer).not.toHaveTextContent('localhost only');
    expect(screen.queryByText(/5s smoothing/i)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('GPU-fixture-0');
    expect(document.body).not.toHaveTextContent('MIG-fixture-0-0');
    expect(document.body).not.toHaveTextContent('Generation');
    const windowControl = screen.getByRole('radiogroup', {
      name: 'Chart window',
    });
    expect(within(windowControl).queryByText('Sampling')).toBeNull();

    for (const copy of [
      'Physical GPUs · 30m',
      'SM activity · 30m',
      'Memory used · 30m',
      'Memory activity · 30m',
      'Host ↔ GPU · 30m',
    ]) {
      expect(screen.queryByText(copy)).toBeNull();
    }

    openView('Status');
    expect(screen.getByRole('heading', { name: 'Status' })).toBeInTheDocument();

    expect(screen.queryByText(/hierarchy discovered/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no outbound requests/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/one line per physical GPU/i),
    ).not.toBeInTheDocument();
  });

  it('persists independent overview and detail chart ranges', async () => {
    const dashboard = result(snapshot());
    mockUseLeviathan.mockReturnValue(dashboard);
    render(<App />);

    const fifteenMinutes = await screen.findByRole('radio', { name: '15m' });
    fireEvent.click(fifteenMinutes);
    expect(localStorage.getItem('leviathan.chartWindow.v1')).toBe(
      String(15 * 60 * 1000),
    );
    expect(
      await screen.findByRole('figure', { name: 'GPU activity over 15m' }),
    ).toBeInTheDocument();

    openView('Resources');
    fireEvent.click(screen.getByRole('button', { name: /GI 1 · CI 0/ }));
    expect(
      await screen.findByRole('heading', { name: 'Activity', level: 4 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('figure', { name: '30m activity history' }),
    ).toBeInTheDocument();
    const detailWindow = screen.getByRole('radiogroup', {
      name: 'Detail chart window',
    });
    fireEvent.click(within(detailWindow).getByRole('radio', { name: '5m' }));
    expect(localStorage.getItem('leviathan.detailChartWindow.v1')).toBe(
      String(5 * 60 * 1000),
    );
    expect(
      await screen.findByRole('figure', { name: '5m activity history' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('figure', { name: 'GPU activity over 15m' }),
    ).toBeNull();
    await waitFor(() =>
      expect(dashboard.history).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        '5m',
      ),
    );
  });

  it('refetches aligned history whenever the selected range changes', async () => {
    const dashboard = result(snapshot());
    mockUseLeviathan.mockReturnValue(dashboard);
    render(<App />);
    await screen.findByRole('heading', { name: 'GPU temperature' });
    await waitFor(() =>
      expect(dashboard.alignedHistory).toHaveBeenCalledTimes(7),
    );

    fireEvent.click(screen.getByRole('radio', { name: '1h' }));
    await waitFor(() =>
      expect(dashboard.alignedHistory).toHaveBeenCalledTimes(14),
    );
    expect(dashboard.alignedHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ window: '1h', maxPoints: 720 }),
    );

    fireEvent.click(screen.getByRole('radio', { name: '5m' }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: '5m' })).toBeChecked();
      expect(dashboard.alignedHistory).toHaveBeenCalledTimes(21);
    });
    expect(dashboard.alignedHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ window: '5m', maxPoints: 720 }),
    );
  });

  it('disables ranges beyond retention and displays a shorter custom retention', async () => {
    const settings: RuntimeSettings = {
      samplingIntervalMs: 1000,
      profileIntervalMs: 1000,
      processIntervalMs: 1000,
      historyWindowMs: 4 * 60 * 1000,
      allowedSamplingIntervalsMs: [500, 1000, 2000],
    };
    mockUseLeviathan.mockReturnValue(
      result(snapshot(), 'live', null, settings),
    );
    render(<App />);

    for (const label of ['5m', '15m', '30m', '1h', '4h', '12h']) {
      expect(await screen.findByRole('radio', { name: label })).toBeDisabled();
    }
    expect(
      await screen.findByRole('figure', { name: 'GPU activity over 4m' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      'Leviathan v0.1.0',
    );
    openView('Resources');
    fireEvent.click(screen.getByRole('button', { name: /GI 1 · CI 0/ }));
    expect(
      await screen.findByRole('figure', { name: '4m activity history' }),
    ).toBeInTheDocument();
    const detailWindow = screen.getByRole('radiogroup', {
      name: 'Detail chart window',
    });
    for (const label of ['5m', '15m', '30m', '1h', '4h', '12h']) {
      expect(
        within(detailWindow).getByRole('radio', { name: label }),
      ).toBeDisabled();
    }
  });

  it.each(['0', '1000', '2000'])(
    'ignores saved cadence %s and changes from older tabs',
    (saved) => {
      localStorage.setItem('leviathan.displayCadence.v1', saved);
      const dashboard = result(snapshot());
      mockUseLeviathan.mockReturnValue(dashboard);
      render(<App />);
      expect(mockUseLeviathan).toHaveBeenLastCalledWith(500);
      fireEvent(
        window,
        new StorageEvent('storage', {
          key: 'leviathan.displayCadence.v1',
          newValue: '2000',
        }),
      );
      openView('Resources');
      expect(mockUseLeviathan).toHaveBeenLastCalledWith(500);
      expect(
        screen.queryByRole('radiogroup', { name: 'View updates' }),
      ).toBeNull();
      expect(dashboard.updateSamplingInterval).not.toHaveBeenCalled();
    },
  );

  it('focuses and pins patterned chart series from the legend', async () => {
    mockUseLeviathan.mockReturnValue(
      result(snapshot([populatedGPU(0), populatedGPU(1)])),
    );
    render(<App />);

    const temperaturePanel = (
      await screen.findByRole('heading', { name: 'GPU temperature' })
    ).closest('section');
    expect(temperaturePanel).not.toBeNull();
    const gpu0 = within(temperaturePanel as HTMLElement).getByRole('button', {
      name: /^Focus GPU 0\. Current /u,
    });
    const gpu1 = within(temperaturePanel as HTMLElement).getByRole('button', {
      name: /^Focus GPU 1\. Current /u,
    });
    const panel = gpu0.closest('section');
    expect(panel).not.toBeNull();
    const legend = gpu0.closest('.mobile-chart-legend');
    expect(legend).not.toBeNull();
    expect(legend).toHaveAttribute('data-series-count', '2');
    expect(gpu0).toHaveClass('mobile-chart-legend-item');
    expect(gpu1).toHaveClass('mobile-chart-legend-item');

    await waitFor(() =>
      expect(panel?.querySelectorAll('.overview-series')).toHaveLength(2),
    );
    for (const swatch of panel?.querySelectorAll('[data-series] line') ?? []) {
      expect(swatch).toHaveAttribute('stroke-dasharray');
    }
    const dashPatterns = [
      ...(panel?.querySelectorAll('[data-series] line') ?? []),
    ].map((swatch) => swatch.getAttribute('stroke-dasharray'));
    expect(new Set(dashPatterns).size).toBe(2);
    for (const path of panel?.querySelectorAll(
      '.overview-series .recharts-line-curve',
    ) ?? []) {
      expect(path).toHaveAttribute('stroke-dasharray');
      expect(path).toHaveAttribute('stroke-linecap', 'round');
      expect(path).toHaveAttribute('stroke-linejoin', 'round');
    }

    fireEvent.mouseEnter(gpu0);
    await waitFor(() => {
      expect(panel?.querySelectorAll('.overview-series-focused')).toHaveLength(
        1,
      );
      expect(panel?.querySelectorAll('.overview-series-muted')).toHaveLength(1);
    });
    expect(gpu0).toHaveAttribute('aria-pressed', 'false');

    fireEvent.mouseLeave(gpu0);
    await waitFor(() =>
      expect(
        panel?.querySelector('.overview-series-focused'),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(gpu0);
    expect(gpu0).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(panel?.querySelectorAll('.overview-series-focused')).toHaveLength(
        1,
      ),
    );

    fireEvent.focus(gpu1);
    await waitFor(() => {
      expect(panel?.querySelectorAll('.overview-series-focused')).toHaveLength(
        1,
      );
      expect(gpu1).toHaveClass('text-foreground');
    });
    fireEvent.blur(gpu1);
    await waitFor(() => expect(gpu0).toHaveClass('text-foreground'));

    fireEvent.click(gpu0);
    expect(gpu0).toHaveAttribute('aria-pressed', 'false');
  });

  it('uses concise chart state messages', async () => {
    const unresolved = new Promise<never>(() => undefined);
    mockUseLeviathan.mockReturnValue({
      ...result(snapshot([GPUWithoutMetrics()])),
      alignedHistory: vi.fn(() => unresolved),
    });
    const loadingView = render(<App />);
    expect(
      (await screen.findAllByText('Loading history…')).length,
    ).toBeGreaterThanOrEqual(6);
    loadingView.unmount();

    mockUseLeviathan.mockReturnValue({
      ...result(snapshot([GPUWithoutMetrics()]), 'reconnecting'),
      alignedHistory: vi.fn(() => unresolved),
    });
    const disconnectedView = render(<App />);
    expect((await screen.findAllByText('History disconnected.')).length).toBe(
      6,
    );
    disconnectedView.unmount();

    mockUseLeviathan.mockReturnValue({
      ...result(snapshot([GPUWithoutMetrics()])),
      alignedHistory: vi.fn(async (request) => ({
        window: request.window,
        series: request.series,
        points: [],
      })),
    });
    const unavailableView = render(<App />);
    expect(
      (await screen.findAllByText('Metric unavailable.')).length,
    ).toBeGreaterThanOrEqual(6);
    unavailableView.unmount();

    mockUseLeviathan.mockReturnValue({
      ...result(snapshot()),
      alignedHistory: vi.fn(async (request) => ({
        window: request.window,
        series: request.series,
        points: [],
      })),
    });
    render(<App />);
    expect(
      (await screen.findAllByText('Collecting history…')).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('loads aligned history once per panel and reloads on topology generation change', async () => {
    const alignedHistory = vi.fn(async (request) => ({
      window: request.window,
      series: request.series,
      points: [],
    }));
    let current = snapshot();
    const dashboardState = result(current);
    mockUseLeviathan.mockImplementation(() => ({
      ...dashboardState,
      snapshot: current,
      alignedHistory,
    }));
    const dashboard = render(<App />);
    await screen.findByRole('heading', { name: 'GPU temperature' });
    await waitFor(() => expect(alignedHistory).toHaveBeenCalledTimes(7));

    current = snapshot();
    current.sequence = 13;
    current.sampledAt = '2026-08-29T12:00:01Z';
    dashboard.rerender(<App />);
    await waitFor(() => expect(alignedHistory).toHaveBeenCalledTimes(7));

    current = snapshot();
    current.sequence = 14;
    current.sampledAt = '2026-08-29T12:00:02Z';
    current.gpus[0].gpuInstances[0].generation = 'GPU-fixture-0/gi/1@g2';
    dashboard.rerender(<App />);
    await waitFor(() => expect(alignedHistory).toHaveBeenCalledTimes(13));
  });

  it('shows one concise instance identity without repeated hierarchy details', async () => {
    mockUseLeviathan.mockReturnValue(result(snapshot()));
    render(<App />);
    openView('Resources');
    const instanceButton = screen.getByRole('button', {
      name: /GI 1 · CI 0/,
    });
    fireEvent.click(instanceButton);
    const dialog = await screen.findByRole('dialog', {
      name: 'GPU 0 · GI 1 · CI 0',
    });
    expect(within(dialog).queryByText('Hierarchy')).not.toBeInTheDocument();
    expect(within(dialog).getAllByText('1g.24gb')).toHaveLength(1);
    expect(within(dialog).getAllByText('1c.1g.24gb')).toHaveLength(1);
    expect(screen.queryByText('Placement')).not.toBeInTheDocument();
    expect(screen.queryByText('Ownership')).not.toBeInTheDocument();
    expect(screen.queryByText('in-memory')).not.toBeInTheDocument();
  });

  it('opens a live full-GPU detail view with physical telemetry and history', async () => {
    let current = snapshot([fullGPU()]);
    const dashboard = result(current);
    mockUseLeviathan.mockImplementation(() => ({
      ...dashboard,
      snapshot: current,
    }));
    const view = render(<App />);
    openView('Resources');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open GPU 2 full GPU details',
      }),
    );
    const dialog = await screen.findByTestId('detail-sheet');
    expect(dialog).toHaveAttribute('data-testid', 'detail-sheet');
    expect(
      within(dialog).getByTestId('detail-history-chart'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: 'GPU 2 · Full GPU' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Full GPU')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('GPU-fixture-2');
    for (const value of [
      '100.0%',
      '98.4%',
      '89.0%',
      '3.0 GiB/s',
      '2.0 GiB/s',
      '1.0 GiB/s',
      '82°C',
      '300 W',
      '1807 MHz',
      '13365 MHz',
    ]) {
      expect(within(dialog).getAllByText(value).length).toBeGreaterThan(0);
    }
    expect(within(dialog).getAllByText('100%').length).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole('radiogroup', { name: 'Detail chart window' }),
    ).toBeInTheDocument();
    const activityLegend = within(dialog).getByRole('list', {
      name: 'Activity chart series',
    });
    const activityPatterns = [...activityLegend.querySelectorAll('line')].map(
      (line) => line.getAttribute('stroke-dasharray'),
    );
    expect(new Set(activityPatterns).size).toBe(3);
    expect(
      within(dialog).getByRole('list', {
        name: 'PCIe transfer chart series',
      }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('in-memory')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(dashboard.history).toHaveBeenCalledWith(
        'GPU-fixture-2',
        [
          'gpu_activity',
          'sm_activity',
          'memory_activity',
          'pcie_rx_bytes_per_second',
          'pcie_tx_bytes_per_second',
        ],
        '30m',
      ),
    );

    current = snapshot([fullGPU()]);
    current.sequence = 13;
    current.sampledAt = '2026-08-29T12:00:01Z';
    current.gpus[0].metrics.gpu_activity.value = 44;
    view.rerender(<App />);
    expect(await within(dialog).findByText('44.0%')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('uses the concise shared-metric notice for multi-CI instances', async () => {
    const gpu = populatedGPU();
    const first = gpu.gpuInstances[0].computeInstances[0];
    gpu.gpuInstances[0].computeInstances.push({
      ...first,
      uuid: 'MIG-fixture-0-1',
      id: 1,
      generation: 'MIG-fixture-0-1@g1',
    });
    mockUseLeviathan.mockReturnValue(result(snapshot([gpu])));
    render(<App />);
    openView('Resources');

    fireEvent.click(screen.getByRole('button', { name: /CI 0/ }));
    expect(
      await screen.findByText('GI metrics are shared by 2 CIs.'),
    ).toBeInTheDocument();
  });
});
