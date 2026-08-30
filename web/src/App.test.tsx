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
  gi.memory = {
    ...gi.memory,
    totalBytes: null,
    usedBytes: null,
    freeBytes: null,
    status: 'unsupported',
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

function result(
  current: Snapshot | null,
  connection = 'live',
  error: string | null = null,
  settings: RuntimeSettings = {
    samplingIntervalMs: 1000,
    historyWindowMs: 60 * 60 * 1000,
    allowedSamplingIntervalsMs: [500, 1000, 2000],
  },
) {
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
          values: {
            temperature: 47,
            gpu_activity: 61,
            sm_activity: 60,
            memory_used_bytes: 4_294_967_296,
            memory_total_bytes: 25_769_803_776,
          },
        },
      ],
    })),
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

  it('combines healthy live status and sampling in the desktop header', () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);

    const capsule = screen.getByTestId('desktop-live-sampling');
    expect(within(capsule).getByText('Live')).toBeInTheDocument();
    expect(within(capsule).queryByText(/#12/)).not.toBeInTheDocument();
    expect(within(capsule).getByText('Sampling')).toBeInTheDocument();
    expect(within(capsule).getByRole('button', { name: '1s' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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
      within(popup).getByText('Shared live update cadence.'),
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
    expect(screen.getAllByText('GPU processes').length).toBeGreaterThan(0);
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

  it('uses the GPU-connected empty-state wording for a healthy zero count', () => {
    mockUseMIGLens.mockReturnValue(result(snapshot([populatedGPU()], [], [])));
    render(<App />);
    expect(screen.getByText('No GPU-connected processes.')).toBeInTheDocument();
  });

  it('renders all four overview chart panels with scoped series labels', async () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);
    for (const name of ['Temperature', 'Utilization', 'Memory', 'SM Active']) {
      expect(await screen.findByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByText('GPU 0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('GPU 0 · GI 1').length).toBeGreaterThan(0);
  });

  it('uses concise dashboard copy', async () => {
    mockUseMIGLens.mockReturnValue(result(snapshot()));
    render(<App />);

    expect(
      screen.getByText('Live GPU, MIG, and CUDA process telemetry.'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 GI · 1 CI')).toBeInTheDocument();
    expect(
      screen.getByText('CUDA clients · current PID namespace'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Unavailable metrics and provider issues.'),
    ).toBeInTheDocument();
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent(
      'Built with ⚔️ by Intellisys Dragoons and Codex · MIGLens v0.1.0',
    );
    expect(screen.getByText('Intellisys Dragoons').tagName).toBe('STRONG');
    expect(footer).not.toHaveTextContent('linux/amd64');
    expect(footer).not.toHaveTextContent('localhost only');
    expect(screen.queryByText(/5s smoothing/i)).not.toBeInTheDocument();
    const windowControl = screen.getByRole('group', {
      name: 'Chart window',
    });
    expect(within(windowControl).queryByText('Sampling')).toBeNull();

    for (const copy of [
      '30m · Physical GPUs',
      '30m · GPU activity by GI',
      '30m · GI memory used',
      '30m · SM activity by GI',
    ]) {
      expect(await screen.findByText(copy)).toBeInTheDocument();
    }

    expect(screen.queryByText(/hierarchy discovered/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no outbound requests/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/one line per physical GPU/i),
    ).not.toBeInTheDocument();
  });

  it('persists one chart range and applies it to overview and detail charts', async () => {
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
    expect(await screen.findByText('15m activity')).toBeInTheDocument();
    await waitFor(() =>
      expect(dashboard.history).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        '15m',
      ),
    );
  });

  it('refetches history only when the selected range expands', async () => {
    const dashboard = result(snapshot());
    mockUseMIGLens.mockReturnValue(dashboard);
    render(<App />);
    await screen.findByRole('heading', { name: 'Temperature' });
    await waitFor(() => expect(dashboard.history).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => expect(dashboard.history).toHaveBeenCalledTimes(4));
    expect(dashboard.history).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Array),
      '1h',
    );

    fireEvent.click(screen.getByRole('button', { name: '5m' }));
    await waitFor(() =>
      expect(screen.getByText('5m · Physical GPUs')).toBeInTheDocument(),
    );
    expect(dashboard.history).toHaveBeenCalledTimes(4);
  });

  it('disables ranges beyond retention and displays a shorter custom retention', async () => {
    const settings: RuntimeSettings = {
      samplingIntervalMs: 1000,
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
  });

  it('applies sampling changes and keeps custom startup cadences visible', async () => {
    const settings: RuntimeSettings = {
      samplingIntervalMs: 250,
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
    fireEvent.click(screen.getByRole('button', { name: '0.5s' }));
    expect(screen.getByText('Applying 0.5s…')).toBeInTheDocument();
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

    const gpu0 = await screen.findByRole('button', { name: 'Focus GPU 0' });
    const gpu1 = screen.getByRole('button', { name: 'Focus GPU 1' });
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
      history: vi.fn(() => unresolved),
    });
    const loadingView = render(<App />);
    expect((await screen.findAllByText('Loading history…')).length).toBe(4);
    loadingView.unmount();

    mockUseMIGLens.mockReturnValue({
      ...result(snapshot([GPUWithoutMetrics()]), 'reconnecting'),
      history: vi.fn(() => unresolved),
    });
    const disconnectedView = render(<App />);
    expect((await screen.findAllByText('History disconnected.')).length).toBe(
      4,
    );
    disconnectedView.unmount();

    mockUseMIGLens.mockReturnValue({
      ...result(snapshot([GPUWithoutMetrics()])),
      history: vi.fn(async (entity: string, metrics: string[]) => ({
        entity,
        metrics,
        window: '30m0s',
        points: [],
      })),
    });
    const unavailableView = render(<App />);
    expect((await screen.findAllByText('Metric unavailable.')).length).toBe(4);
    unavailableView.unmount();

    mockUseMIGLens.mockReturnValue({
      ...result(snapshot()),
      history: vi.fn(async (entity: string, metrics: string[]) => ({
        entity,
        metrics,
        window: '30m0s',
        points: [],
      })),
    });
    render(<App />);
    expect((await screen.findAllByText('Collecting history…')).length).toBe(4);
  });

  it('loads overview history once per entity and reloads on topology generation change', async () => {
    const history = vi.fn(async (entity: string, metrics: string[]) => ({
      entity,
      metrics,
      window: '30m0s',
      points: [],
    }));
    let current = snapshot();
    mockUseMIGLens.mockImplementation(() => ({
      snapshot: current,
      connection: 'live',
      error: null,
      history,
    }));
    const dashboard = render(<App />);
    await screen.findByRole('heading', { name: 'Temperature' });
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));

    current = snapshot();
    current.sequence = 13;
    current.sampledAt = '2026-08-29T12:00:01Z';
    dashboard.rerender(<App />);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));

    current = snapshot();
    current.sequence = 14;
    current.sampledAt = '2026-08-29T12:00:02Z';
    current.gpus[0].gpuInstances[0].generation = 'GPU-fixture-0/gi/1@g2';
    dashboard.rerender(<App />);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(4));
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
