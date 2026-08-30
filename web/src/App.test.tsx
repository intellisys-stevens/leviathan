import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, formatBuildVersion } from './App';
import type {
  Attribution,
  Capabilities,
  Diagnostic,
  GPU,
  Process,
  RuntimeSettings,
  Snapshot,
} from './types';

const mockUseMIGLens = vi.hoisted(() => vi.fn());

vi.mock('./use-miglens', () => ({ useMIGLens: mockUseMIGLens }));

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
    gpus,
    processes: gpuProcesses,
    capabilities,
    diagnostics,
  };
}

const workspaceAttribution: Attribution = {
  provider: 'coder-kubernetes',
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
    samplingIntervalMs: 1000,
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

describe('MIGLens dashboard states', () => {
  beforeEach(() => {
    mockUseMIGLens.mockReset();
    localStorage.clear();
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

  it('renders the loading state', () => {
    mockUseMIGLens.mockReturnValue(result(null, 'connecting'));
    render(<App />);
    expect(screen.getByLabelText('Loading GPU topology')).toBeInTheDocument();
  });

  it('renders the empty GPU state while retaining GPU processes', () => {
    mockUseMIGLens.mockReturnValue(result(snapshot([])));
    render(<App />);
    expect(screen.getByText('No NVIDIA GPUs detected')).toBeInTheDocument();
    expect(screen.getByText('4100')).toBeInTheDocument();
  });

  it('keeps the last snapshot visible while disconnected', () => {
    mockUseMIGLens.mockReturnValue(
      result(snapshot(), 'reconnecting', 'stream closed'),
    );
    render(<App />);
    expect(screen.getByText(/Live stream reconnecting/)).toBeInTheDocument();
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    expect(screen.queryByText(/#12/)).not.toBeInTheDocument();
    expect(screen.getByText('GPU 0')).toBeInTheDocument();
  });

  it('renders concise live status beside one neutral cadence control', () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);

    const capsule = screen.getByTestId('desktop-live-sampling');
    expect(within(capsule).getByText('Live')).toBeInTheDocument();
    expect(within(capsule).queryByText(/#12/)).not.toBeInTheDocument();
    expect(within(capsule).queryByText('Sampling')).toBeNull();
    const sampling = within(capsule).getByRole('group', {
      name: 'Sampling interval',
    });
    expect(sampling).toHaveClass('gap-1');
    const selectedSampling = within(sampling).getByRole('button', {
      name: '1s',
    });
    expect(selectedSampling).toHaveAttribute('aria-pressed', 'true');
    expect(selectedSampling).toHaveClass('min-w-10', 'flex-none');
    expect(screen.getByRole('banner')).not.toHaveTextContent('NVML + GPM');
    expect(screen.getByRole('banner')).not.toHaveTextContent(
      /\d{1,2}:\d{2}:\d{2}/,
    );
  });

  it('exposes slower cadences without reserving an empty feedback slot', () => {
    const settings: RuntimeSettings = {
      samplingIntervalMs: 1000,
      profileIntervalMs: 2000,
      processIntervalMs: 5000,
      historyWindowMs: 60 * 60 * 1000,
      allowedSamplingIntervalsMs: [500, 1000, 2000],
    };
    mockUseMIGLens.mockReturnValue(result(snapshot(), 'live', null, settings));
    render(<App />);

    expect(screen.queryByTestId('sampling-update-status')).toBeNull();
    expect(screen.queryByText('Sampling')).toBeNull();
    expect(
      screen.getByTitle('GPU metrics 1s · profiles 2s · processes 5s'),
    ).toBeInTheDocument();
  });

  it('opens and dismisses the accessible mobile sampling popover', async () => {
    const dashboard = result(snapshot());
    mockUseMIGLens.mockReturnValue(dashboard);
    render(<App />);

    const trigger = screen.getByRole('button', {
      name: 'Live status, sampling 1s',
    });
    fireEvent.click(trigger);
    const popup = await screen.findByRole('dialog');
    expect(
      within(popup).getByText('GPU metrics 1s · profiles 1s · processes 1s'),
    ).toBeVisible();

    fireEvent.click(within(popup).getByRole('button', { name: '0.5s' }));
    expect(dashboard.updateSamplingInterval).toHaveBeenCalledWith(500);

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
      remedy: 'Run MIGLens as the workspace user.',
      status: 'permission_denied',
    });
    mockUseMIGLens.mockReturnValue(
      result(
        snapshot(
          [populatedGPU()],
          [repeated('/proc/10'), repeated('/proc/11')],
        ),
      ),
    );
    render(<App />);
    expect(
      screen.getAllByText('GPU process records are incomplete'),
    ).toHaveLength(1);
    expect(screen.getByText(/2 affected entities/)).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('renders and filters current-namespace GPU processes', async () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);
    expect(
      screen.getByRole('heading', { name: 'Host-wide GPU processes' }),
    ).toBeInTheDocument();
    expect(screen.getByText('4100')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter GPU processes'), {
      target: { value: 'research' },
    });
    await waitFor(() => expect(screen.getByText('4100')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Filter GPU processes'), {
      target: { value: 'train.py' },
    });
    await waitFor(() => {
      expect(
        screen.getByText('No GPU processes match this filter.'),
      ).toBeInTheDocument();
    });
  });

  it('switches between GPU and People resources without resetting host panels', async () => {
    const current = snapshot();
    current.attribution = workspaceAttribution;
    const dashboard = result(current);
    mockUseMIGLens.mockReturnValue(dashboard);
    render(<App />);

    await screen.findByRole('heading', { name: 'Temperature' });
    await waitFor(() =>
      expect(dashboard.alignedHistory).toHaveBeenCalledTimes(5),
    );
    const filter = screen.getByLabelText('Filter GPU processes');
    fireEvent.change(filter, { target: { value: 'research' } });

    const viewSwitch = screen.getByRole('group', {
      name: 'Organize resources by',
    });
    fireEvent.click(within(viewSwitch).getByRole('button', { name: 'People' }));

    expect(await screen.findByTestId('people-view')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('training-lab')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Host-wide telemetry' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Scheduler assignments describe allocation, not active GPU use.',
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        'History across this host; the resource view above does not filter these charts.',
      ),
    ).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Host-wide GPU processes' }),
    ).toBeInTheDocument();
    expect(filter).toHaveValue('research');
    expect(dashboard.alignedHistory).toHaveBeenCalledTimes(5);
    expect(localStorage.getItem('miglens.dashboardView.v1')).toBe('people');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open GPU 0 · GI 1 · CI 0 details',
      }),
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('restores the persisted People perspective when attribution is configured', () => {
    localStorage.setItem('miglens.dashboardView.v1', 'people');
    const current = snapshot();
    current.attribution = workspaceAttribution;
    mockUseMIGLens.mockReturnValue(result(current));

    render(<App />);

    expect(screen.getByTestId('people-view')).toBeInTheDocument();
    expect(screen.getByText('training-lab')).toBeInTheDocument();
    expect(screen.queryByLabelText('GPU topology')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'People' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps bare-metal dashboards GPU-only', () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);
    expect(
      screen.queryByRole('group', { name: 'Organize resources by' }),
    ).toBeNull();
    expect(screen.getByLabelText('GPU topology')).toBeInTheDocument();
  });

  it('uses semantic temperature and power colors based on physical limits', () => {
    mockUseMIGLens.mockReturnValue(
      result(snapshot([populatedGPU(), fullGPU()])),
    );
    render(<App />);

    expect(
      screen.getByLabelText('Physical GPU temperature 48°C, cool'),
    ).toHaveClass('text-sky-600');
    expect(
      screen.getByLabelText(
        'Physical GPU power 142 W, 57% of power limit, normal',
      ),
    ).toHaveClass('text-primary');
    expect(
      screen.getByLabelText('Physical GPU temperature 82°C, hot'),
    ).toHaveClass('text-destructive');
    expect(
      screen.getByLabelText(
        'Physical GPU power 300 W, 100% of power limit, near limit',
      ),
    ).toHaveClass('text-orange-700');
  });

  it('shows workspace attribution without exposing internal join refs', async () => {
    const current = snapshot();
    current.attribution = workspaceAttribution;
    mockUseMIGLens.mockReturnValue(result(current));
    render(<App />);

    expect(
      screen.getByLabelText('Workspace attribution summary'),
    ).toHaveTextContent(/coder-kubernetes.*1 workspace.*1 device/);
    expect(screen.getAllByText('alice / training-lab').length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText('internal-workload-ref')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /GI 1 \/ CI 0/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Workspace attribution' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('alice / training-lab'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('coder · workspace')).toBeInTheDocument();
    expect(dialog.querySelector('time')).toHaveAttribute('datetime', sampledAt);
    expect(within(dialog).queryByText('internal-workload-ref')).toBeNull();
  });

  it('uses the GPU-connected empty-state wording for a healthy zero count', () => {
    mockUseMIGLens.mockReturnValue(result(snapshot([populatedGPU()], [], [])));
    render(<App />);
    expect(screen.getByText('No GPU-connected processes.')).toBeInTheDocument();
  });

  it('renders all five overview chart panels with scoped series labels', async () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);
    for (const name of [
      'Temperature',
      'Utilization',
      'Memory',
      'Memory Activity',
      'PCIe Transfer',
    ]) {
      expect(await screen.findByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByText('GPU 0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('GPU 0 · GI 1').length).toBeGreaterThan(0);
    const chartLayer = screen
      .getByTestId('memory-chart')
      .closest('[aria-label="30m GPU history"]');
    expect(chartLayer).toHaveClass('z-10');
    expect(screen.getByTestId('process-section')).toBeInTheDocument();
    await waitFor(() => {
      const wrapper = document.querySelector<HTMLElement>(
        '.recharts-tooltip-wrapper',
      );
      expect(wrapper?.style.zIndex).toBe('50');
      expect(wrapper?.style.pointerEvents).toBe('none');
    });
  });

  it('uses concise dashboard copy', async () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'Dashboard' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', {
        name: /^(?:GPU overview|GPU partition overview)$/u,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Live GPU, MIG, and CUDA process telemetry.'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 GI · 1 CI')).toBeInTheDocument();
    expect(screen.getByTestId('process-count')).toHaveTextContent(
      '1 CUDA client',
    );
    expect(
      document.getElementById('process-table-description'),
    ).toHaveTextContent('current PID namespace · not workspace-attributed');
    expect(
      screen.getByText('Unavailable metrics and provider issues.'),
    ).toBeInTheDocument();
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent(
      'Built with ⚔️ by Intellisys Dragoons and Codex · MIGLens v0.1.0',
    );
    expect(
      screen.getByRole('link', { name: 'Intellisys Dragoons' }),
    ).toHaveAttribute('href', 'https://intellisys.haow.us/team/');
    expect(footer).not.toHaveTextContent('linux/amd64');
    expect(footer).not.toHaveTextContent('localhost only');
    expect(screen.queryByText(/5s smoothing/i)).not.toBeInTheDocument();
    const windowControl = screen.getByRole('group', {
      name: 'Chart window',
    });
    expect(within(windowControl).queryByText('Sampling')).toBeNull();

    for (const copy of [
      '30m · Physical GPUs',
      '30m · SM activity by GI · GPU activity for full GPUs',
      '30m · Instance memory used',
      '30m · DRAM bandwidth utilization by GI · read/write busy time for full GPUs',
      '30m · Exact Host → GPU + GPU → Host by GPU / GI',
    ]) {
      expect(await screen.findByText(copy)).toBeInTheDocument();
    }

    expect(screen.queryByText(/hierarchy discovered/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no outbound requests/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/one line per physical GPU/i),
    ).not.toBeInTheDocument();
  });

  it('persists independent overview and detail chart ranges', async () => {
    const dashboard = result(snapshot());
    mockUseMIGLens.mockReturnValue(dashboard);
    render(<App />);

    const fifteenMinutes = await screen.findByRole('button', { name: '15m' });
    fireEvent.click(fifteenMinutes);
    expect(localStorage.getItem('miglens.chartWindow.v1')).toBe(
      String(15 * 60 * 1000),
    );
    expect(await screen.findByText('15m · Physical GPUs')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /GI 1 \/ CI 0/ }));
    expect(await screen.findByText('30m activity')).toBeInTheDocument();
    const detailWindow = screen.getByRole('group', {
      name: 'Detail chart window',
    });
    fireEvent.click(within(detailWindow).getByRole('button', { name: '5m' }));
    expect(localStorage.getItem('miglens.detailChartWindow.v1')).toBe(
      String(5 * 60 * 1000),
    );
    expect(await screen.findByText('5m activity')).toBeInTheDocument();
    expect(screen.getByText('15m · Physical GPUs')).toBeInTheDocument();
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
    mockUseMIGLens.mockReturnValue(dashboard);
    render(<App />);
    await screen.findByRole('heading', { name: 'Temperature' });
    await waitFor(() =>
      expect(dashboard.alignedHistory).toHaveBeenCalledTimes(5),
    );

    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() =>
      expect(dashboard.alignedHistory).toHaveBeenCalledTimes(10),
    );
    expect(dashboard.alignedHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ window: '1h', maxPoints: 720 }),
    );

    fireEvent.click(screen.getByRole('button', { name: '5m' }));
    await waitFor(() => {
      expect(screen.getByText('5m · Physical GPUs')).toBeInTheDocument();
      expect(dashboard.alignedHistory).toHaveBeenCalledTimes(15);
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
    mockUseMIGLens.mockReturnValue(result(snapshot(), 'live', null, settings));
    render(<App />);

    for (const label of ['5m', '15m', '30m', '1h']) {
      expect(await screen.findByRole('button', { name: label })).toBeDisabled();
    }
    expect(await screen.findByText('4m · Physical GPUs')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('MIGLens v0.1.0');
    fireEvent.click(screen.getByRole('button', { name: /GI 1 \/ CI 0/ }));
    expect(await screen.findByText('4m activity')).toBeInTheDocument();
    const detailWindow = screen.getByRole('group', {
      name: 'Detail chart window',
    });
    for (const label of ['5m', '15m', '30m', '1h']) {
      expect(
        within(detailWindow).getByRole('button', { name: label }),
      ).toBeDisabled();
    }
  });

  it('applies sampling changes and keeps custom startup cadences visible', async () => {
    const settings: RuntimeSettings = {
      samplingIntervalMs: 250,
      profileIntervalMs: 250,
      processIntervalMs: 250,
      historyWindowMs: 60 * 60 * 1000,
      allowedSamplingIntervalsMs: [500, 1000, 2000],
    };
    const dashboard = result(snapshot(), 'live', null, settings);
    let rejectUpdate: ((reason: Error) => void) | undefined;
    dashboard.updateSamplingInterval = vi.fn(
      () =>
        new Promise<RuntimeSettings>((_resolve, reject) => {
          rejectUpdate = reject;
        }),
    );
    mockUseMIGLens.mockReturnValue(dashboard);
    render(<App />);

    expect(await screen.findByText('Custom 0.25s')).toBeInTheDocument();
    const cadenceControl = screen.getByRole('group', {
      name: 'Sampling interval',
    });
    fireEvent.click(screen.getByRole('button', { name: '0.5s' }));
    expect(screen.getByText('Applying 0.5s')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Sampling interval' })).toBe(
      cadenceControl,
    );
    expect(
      within(screen.getByTestId('desktop-live-sampling')).getByRole('button', {
        name: '0.5s',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Live status and sampling')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '0.5s' }));
    expect(dashboard.updateSamplingInterval).toHaveBeenCalledTimes(1);
    expect(dashboard.updateSamplingInterval).toHaveBeenCalledWith(500);

    rejectUpdate?.(new Error('Sampling update failed.'));
    expect(
      await screen.findByText('Sampling update failed.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Custom 0.25s')).toBeInTheDocument();
  });

  it('focuses and pins solid chart series from the legend', async () => {
    mockUseMIGLens.mockReturnValue(
      result(snapshot([populatedGPU(0), populatedGPU(1)])),
    );
    render(<App />);

    const temperaturePanel = (
      await screen.findByRole('heading', { name: 'Temperature' })
    ).closest('section');
    expect(temperaturePanel).not.toBeNull();
    const gpu0 = within(temperaturePanel as HTMLElement).getByRole('button', {
      name: 'Focus GPU 0',
    });
    const gpu1 = within(temperaturePanel as HTMLElement).getByRole('button', {
      name: 'Focus GPU 1',
    });
    const panel = gpu0.closest('section');
    expect(panel).not.toBeNull();

    await waitFor(() =>
      expect(panel?.querySelectorAll('.overview-series')).toHaveLength(2),
    );
    for (const swatch of panel?.querySelectorAll('[data-series] line') ?? []) {
      expect(swatch).not.toHaveAttribute('stroke-dasharray');
    }
    for (const path of panel?.querySelectorAll(
      '.overview-series .recharts-line-curve',
    ) ?? []) {
      expect(path).not.toHaveAttribute('stroke-dasharray');
      expect(path).toHaveAttribute('stroke-linecap', 'round');
      expect(path).toHaveAttribute('stroke-linejoin', 'round');
    }

    fireEvent.mouseEnter(gpu0);
    await waitFor(() => {
      const paths = panel?.querySelectorAll('.overview-series');
      expect(paths?.[paths.length - 1]).toHaveClass('overview-series-focused');
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
      expect(panel?.querySelectorAll('.overview-series')?.item(1)).toHaveClass(
        'overview-series-focused',
      ),
    );

    fireEvent.focus(gpu1);
    await waitFor(() => {
      const paths = panel?.querySelectorAll('.overview-series');
      expect(paths?.[paths.length - 1]).toHaveClass('overview-series-focused');
      expect(gpu1).toHaveClass('text-foreground');
    });
    fireEvent.blur(gpu1);
    await waitFor(() => expect(gpu0).toHaveClass('text-foreground'));

    fireEvent.click(gpu0);
    expect(gpu0).toHaveAttribute('aria-pressed', 'false');
  });

  it('uses concise chart state messages', async () => {
    const unresolved = new Promise<never>(() => undefined);
    mockUseMIGLens.mockReturnValue({
      ...result(snapshot([GPUWithoutMetrics()])),
      alignedHistory: vi.fn(() => unresolved),
    });
    const loadingView = render(<App />);
    expect((await screen.findAllByText('Loading history…')).length).toBe(5);
    loadingView.unmount();

    mockUseMIGLens.mockReturnValue({
      ...result(snapshot([GPUWithoutMetrics()]), 'reconnecting'),
      alignedHistory: vi.fn(() => unresolved),
    });
    const disconnectedView = render(<App />);
    expect((await screen.findAllByText('History disconnected.')).length).toBe(
      5,
    );
    disconnectedView.unmount();

    mockUseMIGLens.mockReturnValue({
      ...result(snapshot([GPUWithoutMetrics()])),
      alignedHistory: vi.fn(async (request) => ({
        window: request.window,
        series: request.series,
        points: [],
      })),
    });
    const unavailableView = render(<App />);
    expect((await screen.findAllByText('Metric unavailable.')).length).toBe(5);
    unavailableView.unmount();

    mockUseMIGLens.mockReturnValue({
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
    mockUseMIGLens.mockImplementation(() => ({
      ...dashboardState,
      snapshot: current,
      alignedHistory,
    }));
    const dashboard = render(<App />);
    await screen.findByRole('heading', { name: 'Temperature' });
    await waitFor(() => expect(alignedHistory).toHaveBeenCalledTimes(5));

    current = snapshot();
    current.sequence = 13;
    current.sampledAt = '2026-08-29T12:00:01Z';
    dashboard.rerender(<App />);
    await waitFor(() => expect(alignedHistory).toHaveBeenCalledTimes(5));

    current = snapshot();
    current.sequence = 14;
    current.sampledAt = '2026-08-29T12:00:02Z';
    current.gpus[0].gpuInstances[0].generation = 'GPU-fixture-0/gi/1@g2';
    dashboard.rerender(<App />);
    await waitFor(() => expect(alignedHistory).toHaveBeenCalledTimes(10));
  });

  it('shows hierarchy details without placement or ownership', async () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);
    const instanceButton = screen.getByRole('button', {
      name: /GI 1 \/ CI 0/,
    });
    expect(instanceButton.parentElement).toHaveClass('flex-1', 'basis-0');
    fireEvent.click(instanceButton);
    await waitFor(() =>
      expect(screen.getByText('Hierarchy')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Placement')).not.toBeInTheDocument();
    expect(screen.queryByText('Ownership')).not.toBeInTheDocument();
    expect(screen.queryByText('in-memory')).not.toBeInTheDocument();
  });

  it('opens a live full-GPU detail view with physical telemetry and history', async () => {
    let current = snapshot([fullGPU()]);
    const dashboard = result(current);
    mockUseMIGLens.mockImplementation(() => ({
      ...dashboard,
      snapshot: current,
    }));
    const view = render(<App />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open GPU 2 full GPU details',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-testid', 'detail-sheet');
    expect(
      within(dialog).getByTestId('detail-history-chart'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('GPU 2 · Full GPU')).toBeInTheDocument();
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
      expect(within(dialog).getByText(value)).toBeInTheDocument();
    }
    expect(within(dialog).getAllByText('100%').length).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole('group', { name: 'Detail chart window' }),
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
    mockUseMIGLens.mockReturnValue(result(snapshot([gpu])));
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /CI 0/ }));
    expect(
      await screen.findByText('GI metrics are shared by 2 CIs.'),
    ).toBeInTheDocument();
  });
});
