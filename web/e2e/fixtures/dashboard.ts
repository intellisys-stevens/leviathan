import { expect, test, type Locator, type Page } from '@playwright/test';
import process from 'node:process';
import { requireNvidiaWebGL, webGLLaunchArgs } from '../hardware-gpu';
import type { Snapshot } from '../../src/types';
export { expect, test };

export const sampledAt = '2026-08-30T16:00:00.000Z';
export const gpuUUID = 'GPU-synthetic-00000000';
export const secondGPUUUID = 'GPU-synthetic-11111111';
export const secondGIUUID = 'GI-synthetic-11111111';
export const secondCIUUID = 'MIG-synthetic-11111111';
const syntheticProcessCount = 18;

type SyntheticBackendState = {
  alignedRequests: number;
  injectAlignedGap: boolean;
};

const backendStates = new WeakMap<Page, SyntheticBackendState>();

function metric(value: number, unit: string) {
  return {
    value,
    unit,
    source: 'synthetic',
    scope: 'physical_gpu',
    sampledAt,
    status: 'available',
  };
}

function giMetric(value: number, unit: string) {
  return { ...metric(value, unit), scope: 'gpu_instance' };
}

function hostMetric(value: number, unit: string) {
  return {
    value,
    unit,
    source: 'synthetic',
    scope: 'host',
    sampledAt,
    status: 'available',
  };
}

const memory = {
  totalBytes: 103_079_215_104,
  usedBytes: 41_231_686_042,
  freeBytes: 61_847_529_062,
  source: 'synthetic',
  scope: 'physical_gpu',
  sampledAt,
  status: 'available',
};

export const snapshot = {
  schemaVersion: 'v1',
  sequence: 42,
  sampledAt,
  host: { hostname: 'synthetic-host', os: 'linux', arch: 'amd64' },
  system: {
    uptime: hostMetric(176400, 'seconds'),
    cpu: {
      model: 'Synthetic 16-Core CPU',
      logicalProcessors: 32,
      utilization: hostMetric(37, 'percent'),
      load1: hostMetric(3.2, 'load'),
      load5: hostMetric(2.8, 'load'),
      load15: hostMetric(2.4, 'load'),
      source: 'synthetic',
      sampledAt,
      status: 'available',
    },
    memory: {
      totalBytes: 137_438_953_472,
      usedBytes: 55_834_574_848,
      availableBytes: 81_604_378_624,
      utilization: hostMetric(40.625, 'percent'),
      source: 'synthetic',
      scope: 'host',
      sampledAt,
      status: 'available',
    },
    storage: {
      totalBytes: 1_099_511_627_776,
      usedBytes: 450_971_566_080,
      availableBytes: 648_540_061_696,
      readBytesPerSecond: hostMetric(188_743_680, 'bytes_per_second'),
      writeBytesPerSecond: hostMetric(75_497_472, 'bytes_per_second'),
      filesystems: [
        {
          id: 'fs_synthetic_root',
          mountPoint: '/',
          fsType: 'ext4',
          totalBytes: 1_099_511_627_776,
          usedBytes: 450_971_566_080,
          availableBytes: 648_540_061_696,
          source: 'synthetic',
          scope: 'host',
          sampledAt,
          status: 'available',
        },
      ],
      source: 'synthetic',
      scope: 'host',
      sampledAt,
      status: 'available',
    },
    sampledAt,
    status: 'available',
  },
  gpus: [
    {
      uuid: gpuUUID,
      index: 0,
      name: 'NVIDIA Synthetic GPU',
      pciBusId: '0000:01:00.0',
      migEnabled: false,
      maxMigDevices: 0,
      memory,
      metrics: {
        temperature: metric(51, 'celsius'),
        power: metric(140, 'watts'),
        power_limit: metric(300, 'watts'),
        gpu_activity: metric(100, 'percent'),
        sm_activity: metric(94, 'percent'),
        memory_activity: metric(73, 'percent'),
        pcie_rx_bytes_per_second: metric(1_073_741_824, 'bytes_per_second'),
        pcie_tx_bytes_per_second: metric(536_870_912, 'bytes_per_second'),
        sm_clock: metric(1_800, 'mhz'),
        memory_clock: metric(13_000, 'mhz'),
      },
      gpuInstances: [],
    },
    {
      uuid: secondGPUUUID,
      index: 1,
      name: 'NVIDIA Second Synthetic GPU',
      pciBusId: '0000:02:00.0',
      migEnabled: true,
      maxMigDevices: 1,
      memory: {
        ...memory,
        usedBytes: 28_991_029_248,
        freeBytes: 74_088_185_856,
      },
      metrics: {
        temperature: metric(46, 'celsius'),
        power: metric(96, 'watts'),
        power_limit: metric(300, 'watts'),
        gpu_activity: metric(68, 'percent'),
        sm_activity: metric(63, 'percent'),
        memory_activity: metric(41, 'percent'),
        pcie_rx_bytes_per_second: metric(402_653_184, 'bytes_per_second'),
        pcie_tx_bytes_per_second: metric(201_326_592, 'bytes_per_second'),
        sm_clock: metric(1_620, 'mhz'),
        memory_clock: metric(12_000, 'mhz'),
      },
      gpuInstances: [
        {
          uuid: secondGIUUID,
          id: 0,
          profile: '1g.synthetic',
          generation: `${secondGIUUID}@g1`,
          memory: {
            totalBytes: 25_769_803_776,
            usedBytes: 7_730_941_133,
            freeBytes: 18_038_862_643,
            source: 'synthetic',
            scope: 'gpu_instance',
            sampledAt,
            status: 'available',
          },
          metrics: {
            gpu_activity: giMetric(68, 'percent'),
            sm_activity: giMetric(63, 'percent'),
            dram_activity: giMetric(41, 'percent'),
            pcie_rx_bytes_per_second: giMetric(402_653_184, 'bytes_per_second'),
            pcie_tx_bytes_per_second: giMetric(201_326_592, 'bytes_per_second'),
          },
          computeInstances: [
            {
              uuid: secondCIUUID,
              id: 0,
              profile: '1c.synthetic',
              generation: `${secondCIUUID}@g1`,
              memory: {
                totalBytes: 25_769_803_776,
                usedBytes: 7_730_941_133,
                freeBytes: 18_038_862_643,
                source: 'synthetic',
                scope: 'compute_instance',
                sampledAt,
                status: 'available',
              },
              metrics: {},
            },
          ],
        },
      ],
    },
  ],
  processes: Array.from({ length: syntheticProcessCount }, (_, index) => ({
    pid: 4200 + index,
    user: `synthetic-user-${String(index).padStart(2, '0')}`,
    executable: '/usr/bin/python3',
    commandLine: `python3 synthetic-worker-${String(index).padStart(2, '0')}.py`,
    startTime: `2026-08-30T15:${String(index).padStart(2, '0')}:00.000Z`,
    status: 'available',
    ...(index < 6
      ? { workloadRef: 'opaque-synthetic-workspace-reference' }
      : index < 12
        ? { workloadRef: 'opaque-second-workspace-reference' }
        : {}),
  })),
  capabilities: {
    system: {
      name: 'Synthetic host telemetry',
      available: true,
      status: 'available',
    },
    nvml: { name: 'Synthetic NVML', available: true, status: 'available' },
    gpm: { name: 'Synthetic GPM', available: true, status: 'available' },
    dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
    proc: { name: '/proc', available: true, status: 'available' },
    profileMetrics: true,
  },
  diagnostics: [],
  attribution: {
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
        ref: 'opaque-synthetic-workspace-reference',
        platform: 'coder',
        kind: 'workspace',
        name: 'synthetic-training',
        ownerName: 'synthetic-owner',
      },
      {
        ref: 'opaque-second-workspace-reference',
        platform: 'coder',
        kind: 'workspace',
        name: 'synthetic-inference',
        ownerName: 'second-synthetic-owner',
      },
    ],
    assignments: [
      {
        workloadRef: 'opaque-synthetic-workspace-reference',
        entityType: 'physical_gpu',
        entityUuid: gpuUUID,
        state: 'allocated',
      },
      {
        workloadRef: 'opaque-second-workspace-reference',
        entityType: 'compute_instance',
        entityUuid: secondCIUUID,
        state: 'reserved',
      },
    ],
  },
};

export const settings = {
  samplingIntervalMs: 500,
  profileIntervalMs: 2_000,
  processIntervalMs: 2_000,
  historyWindowMs: 43_200_000,
  allowedSamplingIntervalsMs: [500, 1_000, 2_000],
};

const historyPoints = Array.from({ length: 9 }, (_, index) => {
  const secondsBeforeLatest = (8 - index) * 10;
  const time = new Date(
    new Date(sampledAt).getTime() - secondsBeforeLatest * 1000,
  ).toISOString();
  return {
    sampledAt: time,
    values: {
      temperature: 47 + index * 0.5,
      gpu_activity: 54 + index * 5.75,
      sm_activity: 50 + index * 5.5,
      memory_activity: 35 + index * 4.75,
      dram_activity: 35 + index * 4.75,
      pcie_rx_bytes_per_second: 268_435_456 + index * 100_663_296,
      pcie_tx_bytes_per_second: 134_217_728 + index * 50_331_648,
      memory_used_bytes: 31_138_545_664 + index * 1_258_291_200,
      memory_total_bytes: memory.totalBytes,
      cpu_utilization: 29 + index,
      disk_read_bytes_per_second: 100000000 + index * 10000000,
      disk_write_bytes_per_second: 40000000 + index * 4000000,
      memory_utilization: 36 + index * 0.578125,
      storage_used_bytes: 442_381_631_488 + index * 1_073_741_824,
      storage_total_bytes: 1_099_511_627_776,
    },
  };
});

function valueForSyntheticEntity(
  entity: string,
  name: string,
  value: number,
): number {
  if (entity !== secondGPUUUID && entity !== secondGIUUID) return value;
  if (name === 'temperature') return value - 4;
  if (
    name === 'gpu_activity' ||
    name === 'sm_activity' ||
    name === 'memory_activity' ||
    name === 'dram_activity'
  )
    return Math.max(0, value - 18);
  if (name === 'memory_used_bytes') return Math.round(value * 0.68);
  if (name.startsWith('pcie_')) return Math.round(value * 0.45);
  return value;
}

async function installSyntheticBackend(
  page: Page,
  {
    injectAlignedGap = false,
    representativeHistory = false,
    initialSnapshot = snapshot,
  }: {
    injectAlignedGap?: boolean;
    representativeHistory?: boolean;
    initialSnapshot?: Snapshot | typeof snapshot;
  } = {},
) {
  const state: SyntheticBackendState = {
    alignedRequests: 0,
    injectAlignedGap,
  };
  backendStates.set(page, state);

  const fixtureHistory = representativeHistory
    ? Array.from({ length: 121 }, (_, index) => ({
        sampledAt: new Date(
          Date.parse(sampledAt) - (120 - index) * 15_000,
        ).toISOString(),
        values: {
          ...historyPoints.at(-1)!.values,
          cpu_utilization:
            37 + 15 * Math.sin(index / 7) + 6 * Math.sin(index / 2),
          memory_utilization: 40.625 + 2 * Math.sin(index / 22),
          gpu_activity: 64 + 20 * Math.sin(index / 9) + 9 * Math.cos(index / 4),
          sm_activity: 59 + 18 * Math.sin(index / 9),
          temperature: 48 + 4 * Math.sin(index / 18),
          disk_read_bytes_per_second:
            150_000_000 +
            90_000_000 * Math.sin(index / 8) +
            30_000_000 * Math.cos(index / 3),
          disk_write_bytes_per_second:
            70_000_000 + 38_000_000 * Math.cos(index / 11),
        },
      }))
    : historyPoints;
  await page.addInitScript(
    ({ initialSnapshot, samplingIntervalMs }) => {
      class StableEventSource extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;

        readonly CONNECTING = StableEventSource.CONNECTING;
        readonly OPEN = StableEventSource.OPEN;
        readonly CLOSED = StableEventSource.CLOSED;
        readonly readyState = StableEventSource.OPEN;
        readonly url: string;
        readonly withCredentials = false;
        private currentSnapshot = initialSnapshot;
        private sequence = initialSnapshot.sequence;
        private heartbeat: number | undefined;
        private closed = false;
        private paused = false;
        private errorHandler: ((event: Event) => void) | null = null;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;

        get onerror() {
          return (event: Event) => {
            this.paused = true;
            this.errorHandler?.(event);
          };
        }

        set onerror(handler: ((event: Event) => void) | null) {
          this.errorHandler = handler;
        }

        constructor(url: string | URL) {
          super();
          this.url = String(url);
          Object.defineProperty(window, '__leviathanEventSource', {
            configurable: true,
            value: this,
          });
          queueMicrotask(() => {
            if (this.closed) return;
            this.onopen?.(new Event('open'));
            this.publishSnapshot();
            this.heartbeat = window.setInterval(
              () => this.publishSnapshot(),
              samplingIntervalMs,
            );
          });
        }

        private publishSnapshot() {
          if (this.closed || this.paused) return;
          // Advance freshness without moving the fixed history/metric fixtures.
          super.dispatchEvent(
            new MessageEvent('snapshot', {
              data: JSON.stringify({
                ...this.currentSnapshot,
                sequence: ++this.sequence,
              }),
            }),
          );
        }

        override dispatchEvent(event: Event) {
          if (event.type === 'snapshot' && event instanceof MessageEvent) {
            let next: typeof initialSnapshot | null;
            try {
              next = JSON.parse(String(event.data)) as
                | typeof initialSnapshot
                | null;
            } catch {
              return super.dispatchEvent(event);
            }
            if (!next || !Number.isSafeInteger(next.sequence))
              return super.dispatchEvent(event);
            // Explicit test updates own values and timing; heartbeat traffic must
            // neither overwrite them nor make their fixture sequence obsolete.
            this.sequence = Math.max(this.sequence + 1, next.sequence);
            this.currentSnapshot = { ...next, sequence: this.sequence };
            return super.dispatchEvent(
              new MessageEvent('snapshot', {
                data: JSON.stringify(this.currentSnapshot),
              }),
            );
          }
          return super.dispatchEvent(event);
        }

        close() {
          this.closed = true;
          window.clearInterval(this.heartbeat);
        }
      }

      Object.defineProperty(window, 'EventSource', {
        configurable: true,
        value: StableEventSource,
      });
    },
    {
      initialSnapshot,
      samplingIntervalMs: settings.samplingIntervalMs,
    },
  );

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/snapshot') {
      await route.fulfill({ json: initialSnapshot });
      return;
    }
    if (url.pathname === '/api/v1/status') {
      await route.fulfill({
        json: {
          sampledAt,
          monitorStartedAt: '2026-08-30T14:00:00.000Z',
          monitorUptimeSeconds: 7200,
          retentionDays: 90,
          persistence: { enabled: true, saving: true },
          components: [
            {
              id: 'system',
              label: 'Host telemetry',
              state: 'operational',
              observedAt: sampledAt,
            },
            {
              id: 'gpu',
              label: 'GPU telemetry',
              state: 'operational',
              observedAt: sampledAt,
            },
          ],
          days: Array.from({ length: 90 }, (_, index) => ({
            date: new Date(Date.parse(sampledAt) - (89 - index) * 86400000)
              .toISOString()
              .slice(0, 10),
            expectedSamples: index === 89 ? 960 : 1440,
            components: Object.fromEntries(
              ['system', 'gpu'].map((id) => [
                id,
                {
                  operational:
                    index === 89
                      ? 120
                      : representativeHistory && index >= 3 && index !== 16
                        ? 1440 - (index === 19 ? 24 : index === 20 ? 60 : 0)
                        : 0,
                  degraded: representativeHistory && index === 20 ? 60 : 0,
                  unavailable: representativeHistory && index === 19 ? 24 : 0,
                  unsupported: 0,
                  unknown:
                    index === 89
                      ? 840
                      : representativeHistory && index >= 3 && index !== 16
                        ? 0
                        : 1440,
                },
              ]),
            ),
          })),
        },
      });
      return;
    }
    if (url.pathname === '/api/v1/settings') {
      if (request.method() === 'PATCH') {
        const update = request.postDataJSON() as {
          samplingIntervalMs?: number;
        };
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({
          json: {
            ...settings,
            samplingIntervalMs:
              update.samplingIntervalMs ?? settings.samplingIntervalMs,
          },
        });
      } else {
        await route.fulfill({ json: settings });
      }
      return;
    }
    if (url.pathname === '/api/v1/version') {
      await route.fulfill({
        json: { version: '0.4.0', commit: 'synthetic', buildDate: sampledAt },
      });
      return;
    }
    if (url.pathname === '/api/v1/history') {
      await route.fulfill({
        json: {
          entity: url.searchParams.get('entity') ?? gpuUUID,
          metrics: (url.searchParams.get('metrics') ?? '').split(','),
          window: url.searchParams.get('window') ?? '30m',
          points: fixtureHistory,
        },
      });
      return;
    }
    if (
      url.pathname === '/api/v1/history/aligned' &&
      request.method() === 'POST'
    ) {
      state.alignedRequests += 1;
      const body = request.postDataJSON() as {
        window: string;
        maxPoints: number;
        series: Array<{ key: string; entity: string; metrics: string[] }>;
      };
      const points = fixtureHistory.map((point, pointIndex) => ({
        sampledAt: point.sampledAt,
        values: Object.fromEntries(
          body.series.flatMap((series) => {
            if (
              state.injectAlignedGap &&
              pointIndex === Math.floor(historyPoints.length / 2)
            ) {
              return [];
            }
            return [
              [
                series.key,
                Object.fromEntries(
                  series.metrics.flatMap((name) => {
                    const value =
                      point.values[name as keyof typeof point.values];
                    return typeof value === 'number'
                      ? [
                          [
                            name,
                            valueForSyntheticEntity(series.entity, name, value),
                          ],
                        ]
                      : [];
                  }),
                ),
              ],
            ];
          }),
        ),
      }));
      await route.fulfill({
        json: {
          window: body.window,
          series: body.series,
          points: points.slice(0, body.maxPoints),
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

export async function waitForOverviewCharts(page: Page) {
  await expect(
    page.getByTestId('host-cpu-chart').locator('.recharts-wrapper'),
  ).toBeVisible({ timeout: 20_000 });
}

export const overviewChartIDs = [
  'temperature-chart',
  'utilization-chart',
  'memory-chart',
  'memory-activity-chart',
  'pcie-throughput-chart',
];

export function alignedRequestCount(page: Page) {
  return backendStates.get(page)?.alignedRequests ?? 0;
}

export async function selectWorkloadOwner(page: Page, ownerName: string) {
  if (page.viewportSize()!.width >= 1024) {
    await page
      .getByRole('tab', { name: new RegExp(`^${ownerName}`, 'u') })
      .click();
    return;
  }
  await page.getByLabel('Select user').selectOption({ label: ownerName });
}

export function moveCommands(pathData: string | null) {
  return pathData?.match(/M/gu)?.length ?? 0;
}

export function canvasFrameSignature(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement;
    if (source.dataset.renderer === 'worker')
      return `worker:${source.dataset.frameSequence ?? '0'}`;
    const probe = document.createElement('canvas');
    probe.width = 192;
    probe.height = 112;
    const context = probe.getContext('2d');
    if (!context) throw new Error('2D canvas context unavailable');
    context.drawImage(source, 0, 0, probe.width, probe.height);
    return probe.toDataURL('image/png');
  });
}

export function canvasFramesAreStable(canvas: Locator) {
  return canvas.evaluate(async (element) => {
    const source = element as HTMLCanvasElement;
    if (source.dataset.renderer === 'worker') {
      const first = source.dataset.frameSequence;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return source.dataset.frameSequence === first;
    }
    const signature = () => {
      const probe = document.createElement('canvas');
      probe.width = 192;
      probe.height = 112;
      const context = probe.getContext('2d');
      if (!context) throw new Error('2D canvas context unavailable');
      context.drawImage(source, 0, 0, probe.width, probe.height);
      return probe.toDataURL('image/png');
    };
    const first = signature();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return signature() === first;
  });
}

export function configureDashboardTests({
  initialSnapshot,
  cpuCompositing = false,
}: { initialSnapshot?: Snapshot; cpuCompositing?: boolean } = {}) {
  test.use({
    launchOptions: {
      args:
        cpuCompositing &&
        process.env.BROKKR_RUNNER_NAME &&
        process.env.PLAYWRIGHT_HARDWARE_GPU !== '1'
          ? [...webGLLaunchArgs, '--disable-gpu-compositing']
          : webGLLaunchArgs,
    },
  });
  test.beforeAll(async ({ browser }) => requireNvidiaWebGL(browser));

  // Cold WebGL context creation can consume 17s before the test body runs.
  // The whole-case budget includes fixtures; assertions retain their own deadlines.
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }, testInfo) => {
    const theme = testInfo.project.name.endsWith('-light') ? 'light' : 'dark';
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('leviathan.theme.v1', selectedTheme);
      const snowSeed = sessionStorage.getItem('leviathan.test-snow-seed');
      if (snowSeed !== 'random') {
        (
          window as unknown as { __LEVIATHAN_TEST_SNOW_SEED__: number }
        ).__LEVIATHAN_TEST_SNOW_SEED__ = Number(snowSeed ?? 481516);
      }
    }, theme);
    await installSyntheticBackend(page, {
      initialSnapshot,
      injectAlignedGap: testInfo.title.includes('explicit missing sample'),
      representativeHistory: testInfo.title.includes('matches targeted'),
    });
    const directOperations = testInfo.title.includes('direct Status');
    await page.goto(directOperations ? '/#operations' : '/#overview');
    await expect(
      page.getByRole('heading', {
        name: directOperations ? 'Status' : 'Overview',
        exact: true,
        level: 1,
      }),
    ).toBeVisible();
    if (!directOperations && !initialSnapshot) {
      await waitForOverviewCharts(page);
    }
  });
}
