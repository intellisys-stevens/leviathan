import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  },
});

const sampledAt = '2026-08-30T16:00:00.000Z';
const gpuUUID = 'GPU-synthetic-00000000';
const secondGPUUUID = 'GPU-synthetic-11111111';
const secondGIUUID = 'GI-synthetic-11111111';
const secondCIUUID = 'MIG-synthetic-11111111';
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

const snapshot = {
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

const settings = {
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
  }: { injectAlignedGap?: boolean; representativeHistory?: boolean } = {},
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
      initialSnapshot: snapshot,
      samplingIntervalMs: settings.samplingIntervalMs,
    },
  );

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/snapshot') {
      await route.fulfill({ json: snapshot });
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
  if (!directOperations) {
    await expect(
      page.getByTestId('host-cpu-chart').locator('.recharts-wrapper'),
    ).toBeVisible({ timeout: 20_000 });
  }
});

const overviewChartIDs = [
  'temperature-chart',
  'utilization-chart',
  'memory-chart',
  'memory-activity-chart',
  'pcie-throughput-chart',
];

function alignedRequestCount(page: Page) {
  return backendStates.get(page)?.alignedRequests ?? 0;
}

async function selectWorkloadOwner(page: Page, ownerName: string) {
  if (page.viewportSize()!.width >= 1024) {
    await page
      .getByRole('tab', { name: new RegExp(`^${ownerName}`, 'u') })
      .click();
    return;
  }
  await page.getByLabel('Select user').selectOption({ label: ownerName });
}

function moveCommands(pathData: string | null) {
  return pathData?.match(/M/gu)?.length ?? 0;
}

function canvasFrameSignature(canvas: Locator) {
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

function canvasFramesAreStable(canvas: Locator) {
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

test('renders frost-dragon branding with glass, aurora, and ambient snow layers', async ({
  page,
}, testInfo) => {
  const light = testInfo.project.name.endsWith('-light');
  const root = page.locator('html');
  if (light) await expect(root).not.toHaveClass(/\bdark\b/u);
  else await expect(root).toHaveClass(/\bdark\b/u);

  await expect(page.getByText('Leviathan', { exact: true })).toBeVisible();
  await expect(page.getByText('MIGLens', { exact: true })).toHaveCount(0);
  if (page.viewportSize()!.width < 768) {
    await expect(
      page.getByRole('button', { name: 'Open app menu' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: light ? 'Use dark theme' : 'Use light theme',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
  } else {
    await expect(
      page.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
  }
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    '/leviathan-mark.svg',
  );
  const markResponse = await page.request.get('/leviathan-mark.svg');
  expect(markResponse.status()).toBe(200);
  expect(markResponse.headers()['content-type']).toContain('image/svg+xml');
  expect(await markResponse.text()).toContain(
    '<title id="title">Leviathan frost-dragon mark</title>',
  );
  const headerMark = page.getByTestId('leviathan-header-mark');
  await expect(headerMark).toBeVisible();
  const expectedMarkSize = page.viewportSize()!.width < 768 ? 32 : 40;
  expect(await headerMark.boundingBox()).toMatchObject({
    width: expectedMarkSize,
    height: expectedMarkSize,
  });
  const ambientSnow = page.getByTestId('ambient-snow');
  await expect(ambientSnow).toHaveAttribute('aria-hidden', 'true');
  await expect(ambientSnow).toHaveJSProperty('tagName', 'CANVAS');
  await expect(
    page
      .getByRole('region', { name: 'Host capacity' })
      .locator(':scope > [data-slot="snow-cap"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Host capacity' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'CPU', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'RAM', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Storage', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Storage', exact: true }),
  ).toBeVisible();
  const storageResources = page.getByRole('region', {
    name: 'Storage',
    exact: true,
  });
  await expect(
    storageResources.getByRole('heading', { name: '/', exact: true }),
  ).toBeVisible();
  await expect(
    storageResources.getByText('ext4', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.gpu-card').first()).toBeVisible();

  const visual = await page.evaluate(() => {
    const cardElement = document.querySelector('.frost-panel')!;
    const card = getComputedStyle(cardElement);
    const cardRail = getComputedStyle(cardElement, '::before');
    const header = getComputedStyle(document.querySelector('header')!);
    const shell = document.querySelector('.app-shell')!;
    const auroraPrimary = getComputedStyle(shell, '::before');
    const auroraSecondary = getComputedStyle(shell, '::after');
    const ambientSnow = document.querySelector<HTMLCanvasElement>(
      '[data-testid="ambient-snow"]',
    )!;
    const snowStyle = getComputedStyle(ambientSnow);
    const snowCapElement = document.querySelector<HTMLElement>('.snow-cap')!;
    const snowCap = getComputedStyle(snowCapElement);
    const snowCapBody = getComputedStyle(
      snowCapElement.querySelector<HTMLElement>('.snow-cap-body')!,
    );
    const snowCapShadow = getComputedStyle(
      snowCapElement.querySelector<SVGElement>('.snow-cap-shadow')!,
    );
    const snowCapHighlight = getComputedStyle(
      snowCapElement.querySelector<SVGElement>('.snow-cap-highlight')!,
    );
    const root = getComputedStyle(document.documentElement);
    return {
      auroraPrimary: auroraPrimary.backgroundImage,
      auroraSecondary: auroraSecondary.backgroundImage,
      auroraPrimaryAnimation: auroraPrimary.animationName,
      auroraSecondaryAnimation: auroraSecondary.animationName,
      ambientSnowDisplay: snowStyle.display,
      ambientSnowPointerEvents: snowStyle.pointerEvents,
      ambientSnowPosition: snowStyle.position,
      ambientSnowZIndex: snowStyle.zIndex,
      ambientSnowOverflow: snowStyle.overflow,
      ambientSnowState: ambientSnow.dataset.state,
      snowCapDisplay: snowCap.display,
      snowCapPointerEvents: snowCap.pointerEvents,
      snowCapZIndex: snowCap.zIndex,
      snowCapProfile: snowCapElement.dataset.snowProfile,
      snowCapPiles: Number(snowCapElement.dataset.snowPiles),
      snowCapBodyFill: snowCapBody.fill,
      snowCapShadowFill: snowCapShadow.fill,
      snowCapHighlightStroke: snowCapHighlight.stroke,
      snowCapAnimation: snowCapBody.animationName,
      snowCapFilter: snowCap.filter,
      cardRail: cardRail.backgroundImage,
      cardRadius: Number.parseFloat(card.borderRadius),
      cardBackdrop: card.backdropFilter,
      headerBackdrop: header.backdropFilter,
      headerBorder: Number.parseFloat(header.borderBottomWidth),
      glassPanelToken: root.getPropertyValue('--glass-panel').trim(),
      auroraToken: root.getPropertyValue('--aurora').trim(),
      storedTheme: localStorage.getItem('leviathan.theme.v1'),
      legacyKeys: Object.keys(localStorage).filter((key) =>
        key.startsWith('miglens.'),
      ),
    };
  });
  expect(visual.auroraPrimary).not.toBe('none');
  expect(visual.auroraSecondary).not.toBe('none');
  expect(visual.auroraPrimaryAnimation).toBe('aurora-clockwise');
  expect(visual.auroraSecondaryAnimation).toBe('aurora-counterclockwise');
  expect(visual.ambientSnowDisplay).toBe(light ? 'none' : 'block');
  expect(visual.ambientSnowPointerEvents).toBe('none');
  expect(visual.ambientSnowPosition).toBe('fixed');
  expect(visual.ambientSnowZIndex).toBe('-1');
  expect(visual.ambientSnowOverflow).toBe('clip');
  expect(visual.ambientSnowState).toBe(light ? 'hidden' : 'running');
  expect(visual.snowCapDisplay).toBe(light ? 'none' : 'block');
  expect(visual.snowCapPointerEvents).toBe('none');
  expect(visual.snowCapZIndex).toBe('6');
  expect(visual.snowCapProfile).toBe('generated');
  expect(visual.snowCapPiles).toBeGreaterThanOrEqual(1);
  expect(visual.snowCapPiles).toBeLessThanOrEqual(2);
  if (!light) {
    expect(visual.snowCapBodyFill).not.toBe('none');
    expect(visual.snowCapShadowFill).not.toBe('none');
    expect(visual.snowCapHighlightStroke).not.toBe('none');
  }
  expect(visual.snowCapAnimation).toBe('none');
  expect(visual.snowCapFilter).toBe('none');
  expect(visual.cardRail).not.toBe('none');
  expect(visual.cardRadius).toBe(10);
  // The motherboard keeps HTML focus overlays above the shared WebGL canvas.
  expect(visual.cardBackdrop).toBe('none');
  expect(visual.headerBackdrop).toContain('blur');
  expect(visual.headerBorder).toBeGreaterThanOrEqual(1);
  expect(visual.glassPanelToken).not.toBe('');
  expect(visual.auroraToken).not.toBe('');
  expect(visual.storedTheme).toBe(light ? 'light' : 'dark');
  expect(visual.legacyKeys).toEqual([]);
});

test('animates, pauses, resumes, and theme-gates the ambient snow canvas', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark desktop project verifies the live canvas lifecycle.',
  );
  const canvas = page.getByTestId('ambient-snow');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect
    .poll(() => canvasFrameSignature(canvas), {
      intervals: [80, 120, 180, 250],
      timeout: 6_000,
    })
    .not.toBe('worker:0');

  const firstFrame = await canvasFrameSignature(canvas);
  await expect
    .poll(() => canvasFrameSignature(canvas), {
      intervals: [80, 120, 180, 250],
      timeout: 6_000,
    })
    .not.toBe(firstFrame);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  await expect.poll(() => canvasFramesAreStable(canvas)).toBe(true);

  const pausedFrame = await canvasFrameSignature(canvas);
  await page.evaluate(() => {
    delete (document as unknown as Record<string, unknown>).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect
    .poll(() => canvasFrameSignature(canvas), {
      intervals: [80, 120, 180, 250],
      timeout: 6_000,
    })
    .not.toBe(pausedFrame);

  await page
    .getByRole('button', { name: 'Use light theme' })
    .dispatchEvent('click');
  await expect(canvas).toBeHidden();
  await expect(canvas).toHaveAttribute('data-state', 'hidden');
  await page
    .getByRole('button', { name: 'Use dark theme' })
    .dispatchEvent('click');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-state', 'running');
});

test('renders denser mobile dot snow in the offscreen worker', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark Chromium project measures the canvas renderer.',
  );

  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 800,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Overview', exact: true, level: 1 }),
  ).toBeVisible();

  const canvas = page.getByTestId('ambient-snow');
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect(canvas).toHaveAttribute('data-renderer', 'worker');
  await expect(canvas).toHaveAttribute('data-particle-count', '60');
  await expect(canvas).toHaveAttribute('data-effective-dpr', '1.25');
  await expect
    .poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width))
    .toBe(400);
  await expect
    .poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).height))
    .toBe(1_000);

  const firstSequence = Number(
    await canvas.getAttribute('data-frame-sequence'),
  );
  await expect
    .poll(
      async () => Number(await canvas.getAttribute('data-frame-sequence')),
      { timeout: 3_000 },
    )
    .toBeGreaterThan(firstSequence);
  await session.send('Emulation.clearDeviceMetricsOverride');
});

test('keeps the ambient snow backing store viewport-sized and DPR-capped', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark project verifies the full responsive canvas range.',
  );
  const canvas = page.getByTestId('ambient-snow');

  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    const readMetrics = () =>
      canvas.evaluate((element) => {
        const snow = element as HTMLCanvasElement;
        const bounds = snow.getBoundingClientRect();
        const cappedDPR = Number(snow.dataset.effectiveDpr);
        return {
          backingHeight: snow.height,
          backingWidth: snow.width,
          cappedDPR,
          cssHeight: bounds.height,
          cssWidth: bounds.width,
          left: bounds.left,
          top: bounds.top,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          particleCount: Number(snow.dataset.particleCount),
        };
      });

    await expect
      .poll(async () => {
        const metrics = await readMetrics();
        return (
          Math.abs(
            metrics.backingWidth -
              Math.round(metrics.cssWidth * metrics.cappedDPR),
          ) <= 1 &&
          Math.abs(
            metrics.backingHeight -
              Math.round(metrics.cssHeight * metrics.cappedDPR),
          ) <= 1
        );
      })
      .toBe(true);

    const metrics = await readMetrics();
    expect(metrics.left).toBeCloseTo(0, 1);
    expect(metrics.top).toBeCloseTo(0, 1);
    expect(metrics.cssWidth).toBeCloseTo(metrics.viewportWidth, 0);
    expect(metrics.cssHeight).toBeCloseTo(metrics.viewportHeight, 0);
    const coarse = width < 768;
    expect(metrics.backingWidth / metrics.cssWidth).toBeLessThanOrEqual(1.26);
    expect(metrics.backingHeight / metrics.cssHeight).toBeLessThanOrEqual(1.26);
    expect(metrics.particleCount).toBeGreaterThanOrEqual(coarse ? 60 : 120);
    expect(metrics.particleCount).toBeLessThanOrEqual(coarse ? 100 : 220);
  }

  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 600,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const snow = element as HTMLCanvasElement;
        return {
          dpr: window.devicePixelRatio,
          height: snow.height,
          width: snow.width,
        };
      }),
    )
    .toEqual({ dpr: 2, height: 750, width: 1_000 });
  await session.send('Emulation.clearDeviceMetricsOverride');
});

test('renders healthy aligned history as one continuous path per series', async ({
  page,
}) => {
  await expect.poll(() => alignedRequestCount(page)).toBe(7);

  for (const chartID of overviewChartIDs) {
    const chart = page.getByTestId(chartID);
    const curves = chart.locator('.overview-series path.recharts-line-curve');
    await expect(curves).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      const curve = curves.nth(index);
      await expect
        .poll(async () => moveCommands(await curve.getAttribute('d')))
        .toBe(1);
    }
  }
});

test('emphasizes chart values consistently in both themes', async ({
  page,
}) => {
  const legendItem = page
    .getByTestId('utilization-chart')
    .locator('.mobile-chart-legend-item')
    .first();
  const weights = await legendItem.evaluate((element) => {
    const value = element.querySelector<HTMLElement>('.chart-legend-value')!;
    const label = [...element.querySelectorAll<HTMLElement>('span')].find(
      (candidate) =>
        !candidate.classList.contains('chart-legend-value') &&
        getComputedStyle(candidate).display !== 'none',
    )!;
    return {
      label: Number.parseInt(getComputedStyle(label).fontWeight, 10),
      value: Number.parseInt(getComputedStyle(value).fontWeight, 10),
    };
  });
  expect(weights.label).toBeLessThan(700);
  expect(weights.value).toBe(600);
});

test('keeps closed trend geometry stable while the live bucket updates', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One desktop project verifies immutable closed trend buckets.',
  );
  await expect.poll(() => alignedRequestCount(page)).toBe(7);

  const curve = page
    .getByTestId('utilization-chart')
    .locator('.overview-series path.recharts-line-curve')
    .first();
  const initial = await curve.getAttribute('d');
  expect(initial).not.toBeNull();

  const nextSnapshot = structuredClone(snapshot);
  nextSnapshot.sequence += 1;
  nextSnapshot.sampledAt = new Date(
    new Date(sampledAt).getTime() + 1_000,
  ).toISOString();
  nextSnapshot.gpus[0].metrics.gpu_activity = {
    ...nextSnapshot.gpus[0].metrics.gpu_activity,
    sampledAt: nextSnapshot.sampledAt,
    value: 20,
  };
  await page.evaluate((payload) => {
    const source = (
      window as unknown as {
        __leviathanEventSource: EventTarget;
      }
    ).__leviathanEventSource;
    source.dispatchEvent(
      new MessageEvent('snapshot', { data: JSON.stringify(payload) }),
    );
  }, nextSnapshot);

  await expect.poll(() => curve.getAttribute('d')).not.toBe(initial);
  const updated = await curve.getAttribute('d');
  const commands = (path: string) => path.match(/[ML][^ML]*/gu) ?? [];
  const before = commands(initial!);
  const after = commands(updated!);
  expect(after).toHaveLength(before.length);
  expect(after.slice(0, -1)).toEqual(before.slice(0, -1));

  const snow = page.getByTestId('ambient-snow');
  await expect(snow).toHaveAttribute('data-renderer', 'worker');
  const snowSequence = Number(await snow.getAttribute('data-frame-sequence'));
  await page.evaluate(async (baseSnapshot) => {
    const source = (
      window as unknown as {
        __leviathanEventSource: EventTarget;
      }
    ).__leviathanEventSource;
    for (let index = 0; index < 12; index += 1) {
      const update = structuredClone(baseSnapshot);
      update.sequence += index + 2;
      update.sampledAt = new Date(
        Date.parse(baseSnapshot.sampledAt) + (index + 2) * 1_000,
      ).toISOString();
      update.gpus[0].metrics.gpu_activity.value = 25 + index;
      update.gpus[0].metrics.gpu_activity.sampledAt = update.sampledAt;
      source.dispatchEvent(
        new MessageEvent('snapshot', { data: JSON.stringify(update) }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
  }, snapshot);
  await expect
    .poll(async () => Number(await snow.getAttribute('data-frame-sequence')), {
      timeout: 3_000,
    })
    .toBeGreaterThan(snowSequence);
});

test('keeps chart hover tooltips above plot clipping and inside the viewport', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One desktop project verifies viewport-level tooltip geometry.',
  );
  // Three view transitions include real WebGL initialization on software CI.
  test.setTimeout(60_000);
  await expect.poll(() => alignedRequestCount(page)).toBe(7);

  const assertFloatingTooltip = async (
    frame: Locator,
    tooltipTestId: string,
  ) => {
    const chart = frame.locator('.recharts-wrapper').first();
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    const chartBox = await chart.boundingBox();
    expect(chartBox).not.toBeNull();
    await page.mouse.move(
      chartBox!.x + chartBox!.width - 24,
      chartBox!.y + chartBox!.height / 2,
    );

    const tooltip = page.getByTestId(tooltipTestId);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).not.toContainText(
      /Trend|Latest|minimum|maximum|samples?|bucket|live bucket/iu,
    );
    const geometry = await tooltip.evaluate((element) => {
      const portal = element.closest<HTMLElement>('.chart-tooltip-portal')!;
      const bounds = portal.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        position: getComputedStyle(portal).position,
        pointerEvents: getComputedStyle(portal).pointerEvents,
        zIndex: Number(getComputedStyle(portal).zIndex),
        attachedToBody: document.body.contains(portal),
        insideChartFrame: Boolean(portal.closest('.chart-plot-frame')),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(8);
    expect(geometry.top).toBeGreaterThanOrEqual(8);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 8);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight - 8);
    expect(geometry.position).toBe('fixed');
    expect(geometry.pointerEvents).toBe('none');
    expect(geometry.zIndex).toBeGreaterThanOrEqual(80);
    expect(geometry.attachedToBody).toBe(true);
    expect(geometry.insideChartFrame).toBe(false);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  };

  await assertFloatingTooltip(
    page.getByTestId('memory-chart').locator('.chart-plot-frame'),
    'memory-chart-tooltip',
  );

  await page.getByRole('link', { name: 'Resources' }).click();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const detailChart = page.getByTestId('detail-history-chart');
  await detailChart.scrollIntoViewIfNeeded();
  await assertFloatingTooltip(detailChart, 'detail-activity-tooltip');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const workloadChart = page
    .locator('[data-workload-metric="activity"] .chart-plot-frame')
    .first();
  await workloadChart.scrollIntoViewIfNeeded();
  await assertFloatingTooltip(workloadChart, 'assigned-activity-tooltip');
});

test('uses visible legend values without floating tooltips on mobile', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-narrow-dark',
    'One narrow project verifies touch-first chart interaction.',
  );

  const overviewChart = page.getByTestId('utilization-chart');
  await expect(
    overviewChart.locator('.mobile-chart-legend-item').first(),
  ).toContainText('%');
  await overviewChart.locator('.recharts-wrapper').click();
  await expect(page.locator('.chart-tooltip-portal')).toHaveCount(0);

  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Resources', exact: true, level: 1 }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const detail = page.getByTestId('detail-sheet');
  await expect(detail).toBeVisible();
  await expect(
    detail.getByRole('list', { name: 'Activity chart series' }),
  ).toContainText('%');
  await detail
    .getByTestId('detail-history-chart')
    .locator('.recharts-wrapper')
    .click();
  await expect(page.locator('.chart-tooltip-portal')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const workloadActivity = page.locator('[data-workload-metric="activity"]');
  await expect(workloadActivity.locator('.compact-chart-legend')).toContainText(
    '%',
  );
  await workloadActivity.locator('.recharts-wrapper').click();
  await expect(page.locator('.chart-tooltip-portal')).toHaveCount(0);
});

test('renders an explicit missing sample as separated path segments', async ({
  page,
}) => {
  await expect.poll(() => alignedRequestCount(page)).toBe(7);

  const curves = page
    .getByTestId('utilization-chart')
    .locator('.overview-series path.recharts-line-curve');
  await expect(curves).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    const curve = curves.nth(index);
    await expect
      .poll(async () => moveCommands(await curve.getAttribute('d')))
      .toBe(2);
  }
});

test('lays out GPU cards responsively without rendering opaque identifiers', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Resources' }).click();
  const topology = page.getByRole('region', { name: 'GPUs' });
  const cards = topology.locator('.gpu-card');
  await expect(cards).toHaveCount(2);
  await expect
    .poll(() =>
      cards.nth(0).evaluate((element) =>
        element
          .closest('.workbench-view')!
          .getAnimations()
          .every((animation) => animation.playState === 'finished'),
      ),
    )
    .toBe(true);
  await expect(cards.nth(0).locator('.gpu-full-chip-button')).toHaveCount(1);
  await expect(cards.nth(1).locator('.gpu-ci-button')).toHaveCount(1);
  await expect(cards.locator('.full-gpu-metrics, .mig-partition')).toHaveCount(
    0,
  );
  await expect(cards.locator('.gpu-board-view')).toHaveCount(2);
  const [first, second] = await Promise.all([
    cards.nth(0).boundingBox(),
    cards.nth(1).boundingBox(),
  ]);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();

  const snowGeometry = await cards.nth(1).evaluate((element) => ({
    hostTranslate: getComputedStyle(element).translate,
    capTranslate: getComputedStyle(
      element.querySelector<HTMLElement>(':scope > .snow-cap')!,
    ).translate,
  }));
  expect(snowGeometry.hostTranslate).toBe('none');
  expect(snowGeometry.capTranslate).toBe('none');

  if (page.viewportSize()!.width >= 1024) {
    expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(first!.height - second!.height)).toBeLessThanOrEqual(1);
    expect(second!.x).toBeGreaterThan(first!.x + first!.width);
  } else {
    expect(second!.y - first!.y - first!.height).toBeCloseTo(12, 0);
  }

  for (const identifier of [
    gpuUUID,
    secondGPUUUID,
    secondGIUUID,
    secondCIUUID,
    `${secondCIUUID}@g1`,
  ]) {
    await expect(page.getByText(identifier, { exact: true })).toHaveCount(0);
  }
});

test('changes only browser display cadence with compact accessible status', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const settingsPatches: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname === '/api/v1/settings'
    )
      settingsPatches.push(request.postData() ?? '');
  });
  await page.evaluate(() =>
    localStorage.setItem('leviathan.displayCadence.v1', '2000'),
  );
  await page.reload();
  const header = page.getByRole('banner');
  const desktop = page.getByTestId('desktop-live-sampling');
  const mobile = page.getByTestId('mobile-live-sampling');
  if (page.viewportSize()!.width >= 768) {
    await expect(desktop).toBeVisible();
    await expect(mobile).toBeHidden();
    await expect(desktop.getByText('Live', { exact: true })).toBeVisible();
    const choices = desktop.getByRole('radiogroup', { name: 'View updates' });
    await expect(choices.getByRole('radio', { name: '2s' })).toBeChecked();
    for (const [label, value] of [
      ['1s', '1000'],
      ['0.5s', '500'],
      ['2s', '2000'],
    ]) {
      await choices.getByText(label, { exact: true }).click();
      await expect(choices.getByRole('radio', { name: label })).toBeChecked();
      expect(
        await page.evaluate(() =>
          localStorage.getItem('leviathan.displayCadence.v1'),
        ),
      ).toBe(value);
    }
    expect((await desktop.boundingBox())!.width).toBeLessThan(240);
  } else {
    await expect(desktop).toBeHidden();
    const trigger = mobile.getByRole('button', {
      name: 'Live status, view updates 2s',
    });
    await expect(trigger).toHaveText('Live · 2s');
    for (const control of [
      trigger,
      header.getByRole('button', { name: /Use (light|dark) theme/ }),
      header.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await trigger.click();
    const popup = page.getByRole('dialog');
    await expect(popup).toBeVisible();
    await expect(popup.getByText('synthetic-host')).toBeVisible();
    const choices = popup.getByRole('radiogroup', { name: 'View updates' });
    await expect(
      choices.getByRole('radio', { name: '2s', exact: true }),
    ).toBeChecked();
    for (const [label, value] of [
      ['1s', '1000'],
      ['0.5s', '500'],
      ['2s', '2000'],
    ]) {
      await choices.getByText(label, { exact: true }).click();
      await expect(
        choices.getByRole('radio', { name: label, exact: true }),
      ).toBeChecked();
      expect(
        await page.evaluate(() =>
          localStorage.getItem('leviathan.displayCadence.v1'),
        ),
      ).toBe(value);
    }
    await expect(popup).not.toContainText(
      /This browser updates|Host samples|profiles|processes/,
    );
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await page.reload();
  if (page.viewportSize()!.width >= 768) {
    await expect(desktop.getByRole('radio', { name: '2s' })).toBeChecked();
    await expect(desktop.getByText('Live', { exact: true })).toBeVisible();
  } else {
    await expect(
      mobile.getByRole('button', { name: 'Live status, view updates 2s' }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(
      async () =>
        (await (await fetch('/api/v1/settings')).json()).samplingIntervalMs,
    ),
  ).toBe(500);
  await expect(header).toHaveScreenshot('view-cadence-header.png', {
    animations: 'disabled',
    timeout: 20_000,
  });
  expect(settingsPatches).toEqual([]);
});

test('preserves chart-window motion independently of browser cadence', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One desktop project verifies shared control geometry and independence.',
  );
  const telemetryHeader = page
    .getByRole('heading', { name: 'Activity', exact: true, level: 2 })
    .locator('xpath=..');
  const chartWindow = telemetryHeader.getByRole('radiogroup', {
    name: 'Chart window',
  });
  await expect(page.getByText('All GPUs', { exact: true })).toHaveCount(0);

  const motion = (group: Locator) =>
    group.locator('.segmented-thumb').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        duration: style.transitionDuration,
        property: style.transitionProperty,
        timing: style.transitionTimingFunction,
        transform: style.transform,
      };
    });
  const chartMotion = await motion(chartWindow);
  expect(chartMotion.duration).toBe('0.2s');
  expect(chartMotion.property).toContain('transform');

  const initialTransform = chartMotion.transform;
  await chartWindow.locator('.segmented-item', { hasText: /^15m$/u }).click();
  await expect(chartWindow.getByRole('radio', { name: '15m' })).toBeChecked();
  await expect(
    page
      .getByTestId('desktop-live-sampling')
      .getByRole('radio', { name: '0.5s' }),
  ).toBeChecked();
  await expect
    .poll(async () => (await motion(chartWindow)).transform)
    .not.toBe(initialTransform);
});

test('offers functional 4h and 12h windows with a native narrow selector', async ({
  page,
}) => {
  const requestedWindows: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/v1/history/aligned'
    ) {
      const body = request.postDataJSON() as { window: string };
      requestedWindows.push(body.window);
    }
  });
  const header = page
    .getByRole('heading', { name: 'Activity', exact: true, level: 2 })
    .locator('xpath=..');
  const narrow = header.locator('.chart-window-mobile');
  const wide = header.locator('.chart-window-desktop');

  if (page.viewportSize()!.width < 640) {
    await expect(narrow).toBeVisible();
    await expect(wide).toBeHidden();
    const selector = narrow.getByRole('combobox', { name: 'Chart window' });
    for (const label of ['5m', '15m', '30m', '1h', '4h', '12h']) {
      await expect(
        selector.getByRole('option', { name: label, exact: true }),
      ).toBeEnabled();
    }
    await selector.selectOption(String(4 * 60 * 60 * 1000));
    await expect(selector).toHaveValue(String(4 * 60 * 60 * 1000));
    await expect.poll(() => requestedWindows.includes('4h')).toBe(true);
    await selector.selectOption(String(12 * 60 * 60 * 1000));
    await expect(selector).toHaveValue(String(12 * 60 * 60 * 1000));
  } else {
    await expect(narrow).toBeHidden();
    await expect(wide).toBeVisible();
    const group = wide.getByRole('radiogroup', { name: 'Chart window' });
    for (const label of ['5m', '15m', '30m', '1h', '4h', '12h']) {
      await expect(
        group.getByRole('radio', { name: label, exact: true }),
      ).toBeEnabled();
    }
    await group.locator('.segmented-item', { hasText: /^4h$/u }).click();
    await expect(
      group.getByRole('radio', { name: '4h', exact: true }),
    ).toBeChecked();
    await expect.poll(() => requestedWindows.includes('4h')).toBe(true);
    await group.locator('.segmented-item', { hasText: /^12h$/u }).click();
    await expect(
      group.getByRole('radio', { name: '12h', exact: true }),
    ).toBeChecked();
  }

  await expect.poll(() => requestedWindows.includes('12h')).toBe(true);
  expect(
    await page.evaluate(() => localStorage.getItem('leviathan.chartWindow.v1')),
  ).toBe(String(12 * 60 * 60 * 1000));
});

test('omits the process panel and preserves workspace attribution', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Workloads' }).click();
  await expect(page.getByTestId('people-view')).toBeVisible();
  await expect(page.getByTestId('process-section')).toHaveCount(0);
  await expect(page.getByLabel('Filter GPU processes')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Processes', exact: true }),
  ).toHaveCount(0);
});

test('switches workbench views without reloading retained charts', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await expect.poll(() => alignedRequestCount(page)).toBe(7);
  await page.getByRole('link', { name: 'Workloads' }).click();
  await page.getByRole('link', { name: 'Workloads' }).click();
  await expect(page.getByTestId('people-view')).toBeVisible();
  await selectWorkloadOwner(page, 'synthetic-owner');
  await expect(
    page.getByTestId('person-card').getByRole('heading', {
      name: 'synthetic-owner',
      level: 3,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('synthetic-training', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('person-card')).not.toContainText(
    'second-synthetic-owner',
  );
  await expect(page.getByTestId('person-card')).not.toContainText(
    'synthetic-inference',
  );
  await expect(
    page.getByRole('button', {
      name: /^Open GPU \d+ · Full GPU details$/u,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Scheduler assignments describe allocation, not active GPU use.',
      { exact: true },
    ),
  ).toHaveCount(0);

  const peopleView = page.getByTestId('people-view');
  await expect(peopleView).not.toContainText('Parent GI metrics');
  await expect(peopleView).not.toContainText('Physical GPU metrics');
  await expect(peopleView.getByText('Allocated', { exact: true })).toHaveCount(
    1,
  );
  await expect(peopleView.getByText('Reserved', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    peopleView.getByRole('progressbar', {
      name: /^GPU \d+ · Full GPU memory used$/u,
    }),
  ).toBeVisible();
  await expect(
    peopleView.getByRole('progressbar', {
      name: /^GPU \d+ · Full GPU GPU activity$/u,
    }),
  ).toBeVisible();

  const personCards = page.getByTestId('person-card');
  await expect(personCards).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: 'Telemetry', level: 4 }),
  ).toBeVisible();
  await expect(peopleView).not.toContainText(
    'Device-scoped signals, not user usage.',
  );
  await expect(page.locator('.workload-telemetry-chart')).toHaveCount(7);
  await expect.poll(() => alignedRequestCount(page)).toBe(8);

  await selectWorkloadOwner(page, 'second-synthetic-owner');
  await expect(page.getByTestId('person-card')).toContainText(
    'synthetic-inference',
  );
  await expect(
    page.getByRole('button', { name: 'Open GPU 1 · GI 0 · CI 0 details' }),
  ).toBeVisible();
  await expect(page.locator('[data-owner-metric]')).toHaveCount(3);
  await expect(page.locator('[data-workload-metric]')).toHaveCount(0);
  await expect.poll(() => alignedRequestCount(page)).toBe(8);

  await selectWorkloadOwner(page, 'synthetic-owner');
  await expect(page.locator('.workload-telemetry-chart')).toHaveCount(7);
  await expect.poll(() => alignedRequestCount(page)).toBe(8);

  await expect(page.getByTestId('process-section')).toHaveCount(0);
  await expect(page.getByTestId('temperature-chart')).toHaveCount(0);
  await expect.poll(() => alignedRequestCount(page)).toBe(8);

  await page.getByRole('link', { name: 'Resources' }).click();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const detail = page.getByTestId('detail-sheet');
  await expect(detail).toBeVisible({ timeout: 20_000 });
  await expect(
    detail.getByText(
      'Measured transfer rate, shown independently by direction.',
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    detail.getByText('synthetic · physical_gpu · available', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Filter GPU processes')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toBeHidden();

  await page
    .getByRole('button', {
      name: 'Open GPU 1 · GI 0 · CI 0 details',
      exact: true,
    })
    .click();
  await expect(detail).toBeVisible({ timeout: 20_000 });
  await expect(
    detail.getByText('synthetic · gpu_instance · available', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Filter GPU processes')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toBeHidden();

  await page.getByRole('link', { name: 'Workloads' }).click();
  await expect(page.getByLabel('Filter GPU processes')).toHaveCount(0);
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(page.getByRole('region', { name: 'GPUs' })).toBeVisible();
  await expect.poll(() => alignedRequestCount(page)).toBe(8);
});

test('keeps every detail percentage tick visible', async ({ page }) => {
  await page.getByRole('link', { name: 'Resources' }).click();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();

  const chart = page.getByTestId('detail-history-chart');
  const sheetGeometry = await page
    .getByTestId('detail-sheet')
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const metrics = element.querySelector<HTMLElement>(
        '[data-testid="detail-live-metrics"]',
      )!;
      const chart = element.querySelector<HTMLElement>(
        '[data-testid="detail-history-chart"]',
      )!;
      const pcieChart = element.querySelector<HTMLElement>(
        '[data-testid="detail-pcie-chart"]',
      )!;
      const chartBounds = chart.getBoundingClientRect();
      const pcieChartBounds = pcieChart.getBoundingClientRect();
      return {
        position: getComputedStyle(element).position,
        top: bounds.top,
        right: bounds.right,
        width: bounds.width,
        height: bounds.height,
        metricColumns:
          getComputedStyle(metrics).gridTemplateColumns.split(' ').length,
        chartHeight: chartBounds.height,
        pcieChartHeight: pcieChartBounds.height,
        chartLeft: chartBounds.left,
        pcieChartLeft: pcieChartBounds.left,
        chartWidth: chartBounds.width,
        pcieChartWidth: pcieChartBounds.width,
      };
    });
  const viewport = page.viewportSize()!;
  expect(sheetGeometry.position).toBe('fixed');
  expect(sheetGeometry.top).toBeLessThanOrEqual(1);
  expect(sheetGeometry.right).toBeGreaterThanOrEqual(viewport.width - 20);
  expect(sheetGeometry.right).toBeLessThanOrEqual(viewport.width);
  expect(sheetGeometry.height).toBeGreaterThanOrEqual(viewport.height - 1);
  if (viewport.width < 768) {
    expect(sheetGeometry.width).toBeCloseTo(viewport.width, 0);
    expect(sheetGeometry.metricColumns).toBe(2);
    expect(sheetGeometry.chartHeight).toBeCloseTo(176, 0);
  } else {
    const expectedWidth = Math.min(
      Math.max(640, viewport.width * 0.68),
      880,
      viewport.width - 32,
    );
    expect(sheetGeometry.width).toBeCloseTo(expectedWidth, 0);
    expect(sheetGeometry.metricColumns).toBe(5);
    expect(sheetGeometry.chartHeight).toBeCloseTo(192, 0);
  }
  expect(sheetGeometry.pcieChartHeight).toBeCloseTo(
    sheetGeometry.chartHeight,
    0,
  );
  expect(sheetGeometry.pcieChartLeft).toBeCloseTo(sheetGeometry.chartLeft, 0);
  expect(sheetGeometry.pcieChartWidth).toBeCloseTo(sheetGeometry.chartWidth, 0);
  await expect(
    page.getByTestId('detail-sheet').getByRole('heading', {
      name: 'Activity',
      level: 4,
    }),
  ).toBeVisible();
  await expect(
    page.getByTestId('detail-sheet').getByRole('heading', {
      name: 'PCIe transfer',
      level: 4,
    }),
  ).toBeAttached();
  await expect(
    page.getByTestId('detail-sheet').getByRole('heading', {
      name: '30m PCIe transfer',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page
      .getByTestId('detail-sheet')
      .getByText('Current / minimum / maximum data', { exact: true }),
  ).toHaveCount(0);
  await expect(chart.locator('.recharts-wrapper')).toBeVisible();
  const labels = chart.locator('svg text');
  for (const label of ['0%', '25%', '50%', '75%', '100%']) {
    await expect(
      labels.filter({ hasText: new RegExp(`^${label}$`, 'u') }),
    ).toHaveCount(1);
  }

  const tick = labels.filter({ hasText: /^100%$/ });

  const bounds = await tick.evaluate((element) => {
    const tickBox = element.getBoundingClientRect();
    const chartBox = element
      .closest('[data-testid="detail-history-chart"]')!
      .getBoundingClientRect();
    return {
      tick: {
        top: tickBox.top,
        right: tickBox.right,
        bottom: tickBox.bottom,
        left: tickBox.left,
      },
      chart: {
        top: chartBox.top,
        right: chartBox.right,
        bottom: chartBox.bottom,
        left: chartBox.left,
      },
    };
  });

  expect(bounds.tick.top).toBeGreaterThanOrEqual(bounds.chart.top);
  expect(bounds.tick.left).toBeGreaterThanOrEqual(bounds.chart.left);
  expect(bounds.tick.right).toBeLessThanOrEqual(bounds.chart.right);
  expect(bounds.tick.bottom).toBeLessThanOrEqual(bounds.chart.bottom);
  await expect(page.getByTestId('detail-sheet')).not.toContainText(gpuUUID);
  await expect(page.getByTestId('detail-sheet')).not.toContainText(
    `${gpuUUID}@g1`,
  );
  const detailSheet = page.getByTestId('detail-sheet');
  const close = detailSheet.getByRole('button', { name: 'Close' });
  await detailSheet.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => detailSheet.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(close).toBeVisible();
  const [sheetBox, closeBox] = await Promise.all([
    detailSheet.boundingBox(),
    close.boundingBox(),
  ]);
  expect(sheetBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.y).toBeGreaterThanOrEqual(sheetBox!.y);
  expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(
    sheetBox!.y + sheetBox!.height,
  );
});

test('renders canonical fixed percentage axes without negative zero', async ({
  page,
}) => {
  for (const chartID of [
    'utilization-chart',
    'memory-chart',
    'memory-activity-chart',
  ]) {
    const chart = page.getByTestId(chartID);
    const labels = chart.locator('svg text');
    for (const tick of ['0%', '25%', '50%', '75%', '100%']) {
      await expect(
        labels.filter({ hasText: new RegExp(`^${tick}$`, 'u') }),
      ).toHaveCount(1);
    }
    const text = await chart.textContent();
    expect(text).not.toMatch(/(?:-0(?:\.0)?%|99964%|\d+\.\d{4,}%)/u);
  }
});

test('direct Status loads avoid history requests and chart initialization', async ({
  page,
}) => {
  await expect(
    page.getByRole('heading', { name: 'Status', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Current status', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Diagnostic details', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('process-section')).toHaveCount(0);
  await expect(page.getByTestId('temperature-chart')).toHaveCount(0);
  await expect.poll(() => alignedRequestCount(page)).toBe(0);

  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /overview-charts|recharts/iu.test(name)),
  );
  expect(resources).toEqual([]);
});

test('navigates all four hash views with current-page and history semantics', async ({
  page,
}) => {
  for (const view of ['Resources', 'Workloads', 'Status', 'Overview']) {
    const link = page.getByRole('link', { name: view });
    await link.click();
    await expect(
      page.getByRole('heading', { name: view, level: 1 }),
    ).toBeFocused();
    await expect(link).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).hash).toBe(`#${view.toLowerCase()}`);
  }

  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Status', level: 1 }),
  ).toBeFocused();
  await page.goForward();
  await expect(
    page.getByRole('heading', { name: 'Overview', level: 1 }),
  ).toBeFocused();
});

test('loads all four canonical hashes as direct top-level views', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One desktop project covers canonical direct entry.',
  );
  for (const view of ['Overview', 'Resources', 'Workloads', 'Status']) {
    await page.goto(`/#${view.toLowerCase()}`);
    await expect(
      page.getByRole('heading', { name: view, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: view, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  }
});

test('canonical and fallback hashes always land at the view top', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One desktop project covers browser-native hash and history scrolling.',
  );

  const scrollOverview = async () => {
    await expect(
      page.getByTestId('host-storage-chart').locator('.recharts-wrapper'),
    ).toBeVisible();
    const offset = await page.evaluate(() => {
      window.scrollTo({ top: 700, behavior: 'instant' });
      return window.scrollY;
    });
    expect(offset).toBeGreaterThan(100);
  };
  const expectViewTop = async (heading: string) => {
    const destination = page.getByRole('heading', {
      name: heading,
      exact: true,
      level: 1,
    });
    // Software-rendered Linux transitions may take longer to mount the view.
    await expect(destination).toBeVisible({ timeout: 15_000 });
    await expect(destination).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  };

  await scrollOverview();
  await page.getByRole('link', { name: 'Resources' }).click();
  await expectViewTop('Resources');

  await page.evaluate(() => {
    window.location.hash = '#';
  });
  await expect(page).toHaveURL(/#overview$/u);
  await expectViewTop('Overview');

  await scrollOverview();
  await page.getByRole('link', { name: 'Resources' }).click();
  await expectViewTop('Resources');
  await page.goBack();
  await expect(page).toHaveURL(/#overview$/u);
  await expectViewTop('Overview');

  await scrollOverview();
  await page.evaluate(() => {
    window.location.hash = '#unknown';
  });
  await expect(page).toHaveURL(/#overview$/u);
  await expectViewTop('Overview');
});

test('balances hardware capacity without duplicate assignments', async ({
  page,
}) => {
  const summary = page.getByRole('region', { name: 'Host capacity' });
  const tiles = summary.getByRole('button');
  await expect(tiles).toHaveCount(4);
  for (const resource of ['CPU', 'RAM', 'Storage', 'GPU'])
    await expect(
      summary.getByRole('button', { name: `Inspect ${resource} resources` }),
    ).toBeVisible();
  const widths = await tiles.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  await expect(
    page.getByRole('button', { name: /Assignment integration/u }),
  ).toHaveCount(0);
  await expect(page.getByTestId('temperature-chart')).toHaveCount(1);
  await summary.getByRole('button', { name: 'Inspect RAM resources' }).click();
  await expect(page.locator('#resource-memory')).toBeFocused();
  await page.getByRole('link', { name: 'Workloads' }).click();
  await expect(
    page.getByRole('button', { name: 'Assignment integration: Connected' }),
  ).toHaveCount(1);
});

test('redirects legacy operations and processes hashes to their destinations', async ({
  page,
}) => {
  await page.goto('/#processes');
  await expect(page).toHaveURL(/#workloads$/u);
  await expect(
    page.getByRole('heading', { name: 'Workloads', exact: true, level: 1 }),
  ).toBeFocused();
  await page.evaluate(() => {
    window.location.hash = '#operations';
  });
  await expect(page).toHaveURL(/#status$/u);
  await expect(
    page.getByRole('heading', { name: 'Status', exact: true, level: 1 }),
  ).toBeFocused();
});

test('keeps Workloads to Operations shell geometry stable', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const geometry = () =>
    page.locator('.workbench-view').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const heading = element.querySelector('h1')!.getBoundingClientRect();
      const main = document.querySelector('main')!.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        headingLeft: heading.left,
        headingTop: heading.top,
        mainLeft: main.left,
        mainWidth: main.width,
        documentWidth: document.documentElement.clientWidth,
        scrollbarGutter: getComputedStyle(document.documentElement)
          .scrollbarGutter,
      };
    });

  await page.getByRole('link', { name: 'Workloads' }).click();
  await expect(
    page.getByRole('heading', { name: 'Workloads', level: 1 }),
  ).toBeFocused();
  const workloads = await geometry();

  await page.getByRole('link', { name: 'Status' }).click();
  await expect(
    page.getByRole('heading', { name: 'Status', level: 1 }),
  ).toBeFocused();
  const operations = await geometry();

  for (const key of [
    'left',
    'top',
    'width',
    'headingLeft',
    'headingTop',
    'mainLeft',
    'mainWidth',
    'documentWidth',
  ] as const) {
    expect(Math.abs(operations[key] - workloads[key]), key).toBeLessThanOrEqual(
      1,
    );
  }
  expect(workloads.scrollbarGutter).toContain('stable');
  expect(operations.scrollbarGutter).toContain('stable');
});

test('opens native GPU chip controls and Workloads resource whitespace', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One pointer-capable project covers stretched resource surfaces.',
  );
  await page.getByRole('link', { name: 'Resources' }).click();

  const gpuCards = page.locator('.gpu-card');
  await expect(gpuCards).toHaveCount(2);
  await expect(gpuCards.first()).toHaveClass(/snow-capped/u);

  const activateWhitespace = async (buttonName: string | RegExp) => {
    const button = page.getByRole('button', { name: buttonName }).first();
    const surface = button.locator('xpath=..');
    const [buttonBox, surfaceBox] = await Promise.all([
      button.boundingBox(),
      surface.boundingBox(),
    ]);
    expect(buttonBox).not.toBeNull();
    expect(surfaceBox).not.toBeNull();
    expect(Math.abs(buttonBox!.width - surfaceBox!.width)).toBeLessThanOrEqual(
      2.1,
    );
    expect(
      Math.abs(buttonBox!.height - surfaceBox!.height),
    ).toBeLessThanOrEqual(2.1);
    await button.click({
      position: {
        x: Math.max(2, buttonBox!.width - 12),
        y: Math.max(2, buttonBox!.height - 12),
      },
    });
    await expect(page.getByTestId('detail-sheet')).toBeVisible();
    await page
      .getByTestId('detail-sheet')
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(page.getByTestId('detail-sheet')).toBeHidden();
  };

  const fullChip = page.getByRole('button', {
    name: 'Open GPU 0 full GPU details',
  });
  await expect(fullChip).toHaveClass(/gpu-full-chip-button/u);
  await fullChip.click();
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  await page
    .getByTestId('detail-sheet')
    .getByRole('button', { name: 'Close' })
    .click();
  const instance = page.getByRole('button', {
    name: 'Open GPU 1 · GI 0 · CI 0 details',
    exact: true,
  });
  await expect(instance).toHaveClass(/gpu-ci-button/u);
  const instanceBounds = (await instance.boundingBox())!;
  expect(instanceBounds.width).toBeGreaterThanOrEqual(44);
  expect(instanceBounds.height).toBeGreaterThanOrEqual(44);
  await instance.click();
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  await page
    .getByTestId('detail-sheet')
    .getByRole('button', { name: 'Close' })
    .click();

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  await activateWhitespace(/^Open GPU \d+ · Full GPU details$/u);
});

test('keeps GPU view layout stationary on keyboard focus and Workloads glow inside its perimeter', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes('narrow'),
    'Desktop themes verify view geometry and Workloads hover effects.',
  );
  await page.getByRole('link', { name: 'Resources' }).click();
  const gpuButton = page.getByRole('button', {
    name: 'Open GPU 0 full GPU details',
  });
  const gpuView = page.locator('.gpu-card').first().locator('.gpu-board-view');
  await expect(gpuView).toBeVisible();
  await gpuView.scrollIntoViewIfNeeded();
  const documentBounds = () =>
    gpuView.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + scrollX,
        y: rect.y + scrollY,
        width: rect.width,
        height: rect.height,
      };
    });
  const before = await documentBounds();
  await page.keyboard.press('Tab');
  await gpuButton.focus();
  await expect(gpuButton).toBeFocused();
  await expect(gpuView).toHaveAttribute(
    'data-highlighted-chip',
    (await gpuButton.getAttribute('data-chip-key'))!,
  );
  const after = await documentBounds();
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(after[key] - before[key])).toBeLessThanOrEqual(1);

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const button = page.getByRole('button', {
    name: /^Open GPU \d+ · Full GPU details$/u,
  });
  const surface = button.locator('xpath=..');
  await surface.hover();
  await expect
    .poll(() =>
      surface.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .toContain(
      testInfo.project.name.endsWith('-dark')
        ? '0px 0px 52px'
        : '0px 20px 52px',
    );
  if (testInfo.project.name.endsWith('-dark')) {
    const mask = surface.locator(':scope > [data-slot="perimeter-light"]');
    const glow = mask.locator('[data-slot="perimeter-light-glow"]');
    await expect(mask).toHaveCSS('opacity', '1');
    await expect(mask).toHaveCSS('pointer-events', 'none');
    await expect(mask).toHaveCSS('overflow', 'hidden');

    const readPhase = () =>
      surface.evaluate((element) => {
        const mask = element.querySelector<HTMLElement>(
          ':scope > [data-slot="perimeter-light"]',
        )!;
        const glow = mask.querySelector<HTMLElement>(
          '[data-slot="perimeter-light-glow"]',
        )!;
        const hostRect = element.getBoundingClientRect();
        const maskRect = mask.getBoundingClientRect();
        const hostStyle = getComputedStyle(element);
        const maskStyle = getComputedStyle(mask);
        const glowStyle = getComputedStyle(glow);
        return {
          host: {
            left: hostRect.left,
            top: hostRect.top,
            right: hostRect.right,
            bottom: hostRect.bottom,
          },
          mask: {
            left: maskRect.left,
            top: maskRect.top,
            right: maskRect.right,
            bottom: maskRect.bottom,
          },
          hostTransform: hostStyle.transform,
          maskTransform: maskStyle.transform,
          maskAnimation: maskStyle.animationName,
          hostRadius: hostStyle.borderRadius,
          maskRadius: maskStyle.borderRadius,
          maskImage: maskStyle.maskImage,
          glowTransform: glowStyle.transform,
          glowAnimation: glowStyle.animationName,
          glowBackground: glowStyle.backgroundImage,
          glowOpacity: Number.parseFloat(glowStyle.opacity),
          animatedProperties: glow
            .getAnimations()
            .flatMap((animation) =>
              animation.effect instanceof KeyframeEffect
                ? animation.effect.getKeyframes()
                : [],
            )
            .flatMap((keyframe) => Object.keys(keyframe))
            .filter(
              (property) =>
                !['offset', 'computedOffset', 'easing', 'composite'].includes(
                  property,
                ),
            ),
        };
      });

    const phases = [await readPhase()];
    for (let phase = 0; phase < 2; phase += 1) {
      await page.waitForTimeout(320);
      phases.push(await readPhase());
    }
    for (const phase of phases) {
      expect(phase.maskTransform).toBe('none');
      expect(phase.maskAnimation).toBe('none');
      expect(phase.glowAnimation).toBe('perimeter-light-breathe');
      expect(phase.glowBackground).toContain('linear-gradient');
      expect(new Set(phase.animatedProperties)).toEqual(new Set(['opacity']));
      expect(phase.maskImage).toContain('linear-gradient');
      expect(phase.maskRadius).toBe(phase.hostRadius);
      expect(Math.abs(phase.host.left - phase.mask.left)).toBeLessThanOrEqual(
        2.1,
      );
      expect(Math.abs(phase.host.top - phase.mask.top)).toBeLessThanOrEqual(
        2.1,
      );
      expect(Math.abs(phase.mask.right - phase.host.right)).toBeLessThanOrEqual(
        2.1,
      );
      expect(
        Math.abs(phase.mask.bottom - phase.host.bottom),
      ).toBeLessThanOrEqual(2.1);
    }
    expect(new Set(phases.map((phase) => phase.glowTransform)).size).toBe(1);
    const glowOpacities = phases.map((phase) => phase.glowOpacity);
    expect(
      Math.max(...glowOpacities) - Math.min(...glowOpacities),
    ).toBeGreaterThan(0.03);
    expect(new Set(phases.map((phase) => phase.hostTransform)).size).toBe(1);
    expect(
      await glow.evaluate((element) => element.getAttribute('style')),
    ).toBe(null);
    expect(
      await surface.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit?.closest('[data-slot="perimeter-light"]') === null;
      }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
  } else {
    await expect(
      surface.locator(':scope > [data-slot="perimeter-light"]'),
    ).toHaveCSS('display', 'none');
  }

  await page.mouse.move(0, 0);
  await button.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(button).toBeFocused();
  await expect
    .poll(() =>
      surface.evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.outlineWidth} ${style.outlineStyle}`;
      }),
    )
    .toBe('2px solid');
  if (testInfo.project.name.endsWith('-dark')) {
    const focusedMask = surface.locator(
      ':scope > [data-slot="perimeter-light"]',
    );
    await expect(focusedMask).toHaveCSS('opacity', '1');
    await expect(
      focusedMask.locator('[data-slot="perimeter-light-glow"]'),
    ).toHaveCSS('animation-name', 'none');
  }

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const workloadSurface = page
    .getByRole('button', {
      name: /^Open GPU \d+ · Full GPU details$/u,
    })
    .locator('xpath=..');
  await workloadSurface.hover();
  await expect
    .poll(() =>
      workloadSurface.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      ),
    )
    .toContain(
      testInfo.project.name.endsWith('-dark')
        ? '0px 0px 52px'
        : '0px 20px 52px',
    );
  await expect(page.locator('.workload-person-detail')).toHaveCSS(
    'overflow',
    'visible',
  );
  await expect(workloadSurface.locator('xpath=../..')).toHaveCSS(
    'overflow',
    'visible',
  );
  await expect(workloadSurface.locator('xpath=../../..')).toHaveCSS(
    'overflow',
    'visible',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test('keeps Overview snow-free and card snow static above hover surfaces', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark fine-pointer project covers foreground snow compositing.',
  );

  await expect(
    page
      .getByRole('region', { name: 'Host capacity' })
      .locator(':scope > [data-slot="snow-cap"]'),
  ).toHaveCount(0);

  await page.getByRole('link', { name: 'Resources' }).click();
  const card = page.locator('.gpu-card').first();
  const cap = card.locator(':scope > [data-slot="snow-cap"]');
  const body = cap.locator('[data-slot="snow-cap-body"]');
  const shadow = cap.locator('[data-slot="snow-cap-shadow"]');
  const highlight = cap.locator('[data-slot="snow-cap-highlight"]');
  const resource = card.locator('.gpu-full-chip-button');

  await expect(cap).toHaveCount(1);
  await expect(cap).toBeVisible();
  await resource.hover();

  const readPhase = () =>
    card.evaluate((element) => {
      const cap = element.querySelector<HTMLElement>(
        ':scope > [data-slot="snow-cap"]',
      )!;
      const body = cap.querySelector<SVGElement>(
        '[data-slot="snow-cap-body"]',
      )!;
      const shadow = cap.querySelector<SVGElement>(
        '[data-slot="snow-cap-shadow"]',
      )!;
      const highlight = cap.querySelector<SVGElement>(
        '[data-slot="snow-cap-highlight"]',
      )!;
      const resource = element.querySelector<HTMLElement>(
        '.gpu-full-chip-button',
      )!;
      const cardRect = element.getBoundingClientRect();
      const chassisRect = cardRect;
      const capRect = cap.getBoundingClientRect();
      const hit = document.elementFromPoint(
        capRect.left + capRect.width / 2,
        capRect.top + capRect.height / 2,
      );
      return {
        cardRect: {
          top: cardRect.top,
          width: cardRect.width,
        },
        chassisRect: {
          left: chassisRect.left,
          right: chassisRect.right,
          width: chassisRect.width,
        },
        capRect: {
          left: capRect.left,
          top: capRect.top,
          right: capRect.right,
          bottom: capRect.bottom,
          width: capRect.width,
          height: capRect.height,
        },
        borderAlignment: Math.abs(
          capRect.top +
            (capRect.height * 15) / 24 -
            chassisRect.top -
            Number.parseFloat(getComputedStyle(element).borderTopWidth),
        ),
        capZIndex: Number.parseInt(getComputedStyle(cap).zIndex, 10),
        resourceZIndex:
          Number.parseInt(getComputedStyle(resource).zIndex, 10) || 0,
        capPointerEvents: getComputedStyle(cap).pointerEvents,
        capAnimation: getComputedStyle(cap).animationName,
        capFilter: getComputedStyle(cap).filter,
        bodyAnimation: getComputedStyle(body).animationName,
        shadowAnimation: getComputedStyle(shadow).animationName,
        highlightAnimation: getComputedStyle(highlight).animationName,
        bodyPaths: body.querySelectorAll('path').length,
        shadowPaths: shadow.querySelectorAll('path').length,
        highlightPaths: highlight.querySelectorAll('path').length,
        hitSnow: hit?.closest('[data-slot="snow-cap"]') != null,
      };
    });

  const phases = [await readPhase()];
  for (let phase = 0; phase < 2; phase += 1) {
    await page.waitForTimeout(320);
    phases.push(await readPhase());
  }
  for (const phase of phases) {
    expect(phase.capZIndex).toBeGreaterThan(phase.resourceZIndex);
    expect(phase.capPointerEvents).toBe('none');
    expect(phase.capAnimation).toBe('none');
    expect(phase.capFilter).toBe('none');
    expect(phase.bodyAnimation).toBe('none');
    expect(phase.shadowAnimation).toBe('none');
    expect(phase.highlightAnimation).toBe('none');
    expect(phase.bodyPaths).toBeGreaterThanOrEqual(1);
    expect(phase.bodyPaths).toBeLessThanOrEqual(2);
    expect(phase.shadowPaths).toBe(phase.bodyPaths);
    expect(phase.highlightPaths).toBeGreaterThan(0);
    expect(phase.hitSnow).toBe(false);
    expect(phase.capRect.top).toBeLessThan(phase.cardRect.top);
    expect(phase.capRect.bottom).toBeLessThanOrEqual(phase.cardRect.top + 20);
    expect(
      phase.capRect.width / phase.chassisRect.width,
    ).toBeGreaterThanOrEqual(0.8);
    expect(phase.capRect.left).toBeGreaterThanOrEqual(phase.chassisRect.left);
    expect(phase.capRect.right).toBeLessThanOrEqual(
      phase.chassisRect.right + 1,
    );
    expect(phase.capRect.height).toBeGreaterThanOrEqual(10);
    expect(phase.borderAlignment).toBeLessThanOrEqual(0.5);
  }
  expect(
    new Set(phases.map(({ capRect }) => JSON.stringify(capRect))).size,
  ).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(body).toHaveCSS('animation-name', 'none');
  await expect(shadow).toHaveCSS('animation-name', 'none');
  await expect(highlight).toHaveCSS('animation-name', 'none');
});

test('keeps every flowing treatment rounded and pointer transparent', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark fine-pointer project covers all perimeter consumers.',
  );

  const assertRoundedPerimeter = async (surface: Locator) => {
    const perimeter = surface.locator(':scope > [data-slot="perimeter-light"]');
    await expect(perimeter).toHaveCount(1);
    const geometry = await surface.evaluate((element) => {
      const perimeter = element.querySelector<HTMLElement>(
        ':scope > [data-slot="perimeter-light"]',
      )!;
      const hostStyle = getComputedStyle(element);
      const perimeterStyle = getComputedStyle(perimeter);
      return {
        hostRadius: hostStyle.borderRadius,
        perimeterRadius: perimeterStyle.borderRadius,
        perimeterPointerEvents: perimeterStyle.pointerEvents,
        perimeterTransform: perimeterStyle.transform,
      };
    });
    expect(geometry.hostRadius).not.toBe('0px');
    expect(geometry.perimeterRadius).toBe(geometry.hostRadius);
    expect(geometry.perimeterPointerEvents).toBe('none');
    expect(geometry.perimeterTransform).toBe('none');
  };

  await assertRoundedPerimeter(
    page.getByRole('link', { name: 'Overview' }).first(),
  );
  await expect(page.locator('.host-capacity-card')).toHaveCount(4);
  await expect(
    page
      .locator('.assignment-status')
      .first()
      .locator(':scope > [data-slot="perimeter-light"]'),
  ).toHaveCount(0);
  await assertRoundedPerimeter(page.locator('.segmented-control').first());

  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.locator('.gpu-card [data-slot="perimeter-light"]'),
  ).toHaveCount(0);
  await expect(page.locator('.gpu-board-view').first()).toBeVisible();
  const gpuControl = page.getByRole('button', {
    name: 'Open GPU 0 full GPU details',
  });
  await page.keyboard.press('Tab');
  await gpuControl.focus();
  expect(
    await gpuControl.evaluate((element) => element.matches(':focus-visible')),
  ).toBe(true);
  await expect(gpuControl).toHaveCSS('outline-style', 'solid');

  await page.getByRole('link', { name: 'Workloads' }).click();
  await assertRoundedPerimeter(page.locator('.workload-owner-tab').first());
  await assertRoundedPerimeter(
    page.locator('.mobile-workload-resource').first(),
  );

  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('link', { name: 'Overview' }).click();
  await assertRoundedPerimeter(page.locator('.chart-window-mobile').first());
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test('has no serious or critical authored accessibility violations', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const view of ['Overview', 'Resources', 'Workloads', 'Status']) {
    await page.getByRole('link', { name: view }).click();
    let results = await new AxeBuilder({ page }).analyze();
    let blocking = results.violations.filter(
      ({ impact }) => impact === 'serious' || impact === 'critical',
    );
    expect(
      blocking,
      `${view}: ${blocking.map(({ id }) => id).join(', ')}`,
    ).toEqual([]);

    if (view === 'Resources') {
      await page
        .getByRole('button', { name: 'Open GPU 0 full GPU details' })
        .click();
      await expect(page.getByTestId('detail-sheet')).toBeVisible();
      results = await new AxeBuilder({ page }).analyze();
      blocking = results.violations.filter(
        ({ impact }) => impact === 'serious' || impact === 'critical',
      );
      expect(
        blocking,
        `Resource detail: ${blocking.map(({ id }) => id).join(', ')}`,
      ).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('detail-sheet')).toBeHidden();
    }
  }
});

test('removes spatial motion when reduced motion is requested', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const light = testInfo.project.name.endsWith('-light');
  const ambientSnow = page.getByTestId('ambient-snow');
  await expect(ambientSnow).toHaveAttribute(
    'data-state',
    light ? 'hidden' : 'static',
  );
  await page.getByRole('link', { name: 'Resources' }).click();
  const resource = page.locator('.gpu-full-chip-button').first();
  await resource.hover();
  const motion = await page.locator('.workbench-view').evaluate((element) => {
    const view = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const mark = getComputedStyle(
      document.querySelector('[data-testid="leviathan-header-mark"]')!,
    );
    const ambientSnow = document.querySelector<HTMLCanvasElement>(
      '[data-testid="ambient-snow"]',
    )!;
    return {
      animationName: view.animationName,
      transform: view.transform,
      markAnimation: mark.animationName,
      ambientSnowDisplay: getComputedStyle(ambientSnow).display,
      ambientSnowState: ambientSnow.dataset.state,
      resourceTransform: getComputedStyle(
        document.querySelector('.gpu-full-chip-button')!,
      ).transform,
      durationToken: root.getPropertyValue('--duration-view').trim(),
    };
  });
  expect(motion.animationName).toBe('none');
  expect(motion.transform).toBe('none');
  expect(motion.markAnimation).toBe('none');
  expect(motion.ambientSnowDisplay).toBe(light ? 'none' : 'block');
  expect(motion.ambientSnowState).toBe(light ? 'hidden' : 'static');
  expect(motion.resourceTransform).toBe('none');
  expect(
    await page
      .locator('.gpu-card')
      .evaluateAll(
        (cards) =>
          cards
            .flatMap((card) => card.getAnimations({ subtree: true }))
            .filter((animation) => animation.playState === 'running').length,
      ),
  ).toBe(0);
  expect(motion.durationToken).toBe('240ms');
  if (!light) {
    await expect.poll(() => canvasFramesAreStable(ambientSnow)).toBe(true);
  }

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const workloadResource = page
    .getByRole('button', {
      name: /^Open GPU \d+ · Full GPU details$/u,
    })
    .locator('xpath=..');
  await workloadResource.hover();
  await expect(workloadResource).toHaveCSS('transform', 'none');
  await expect
    .poll(() =>
      workloadResource.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      ),
    )
    .toContain(light ? '0px 20px 52px' : '0px 0px 52px');
});

test('removes ambient glass effects for visibility-oriented media preferences', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark desktop project covers the ambient media fallbacks.',
  );
  const ambientSnow = page.getByTestId('ambient-snow');
  const cap = page.locator('.snow-cap').first();
  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const perimeter = page
    .getByRole('button', { name: /^Open GPU \d+ · Full GPU details$/u })
    .locator('xpath=..')
    .locator(':scope > [data-slot="perimeter-light"]');
  await perimeter.locator('xpath=..').hover();

  const visualState = () =>
    page.evaluate(() => {
      const snow = document.querySelector('[data-testid="ambient-snow"]')!;
      const cap = document.querySelector('.snow-cap')!;
      const panel = document.querySelector('.frost-panel')!;
      const perimeter = document.querySelector(
        '.interactive-resource > [data-slot="perimeter-light"]',
      )!;
      return {
        snow: getComputedStyle(snow).display,
        snowState: (snow as HTMLElement).dataset.state,
        cap: getComputedStyle(cap).display,
        backdrop: getComputedStyle(panel).backdropFilter,
        perimeter: getComputedStyle(perimeter).display,
      };
    });

  await expect(ambientSnow).toBeVisible();
  await expect(cap).toBeVisible();
  await expect(perimeter).toHaveCSS('display', 'block');
  await page.emulateMedia({ contrast: 'more' });
  await expect.poll(visualState).toMatchObject({
    snow: 'none',
    snowState: 'hidden',
    cap: 'none',
    backdrop: 'none',
    perimeter: 'none',
  });
  await page.emulateMedia({ contrast: 'no-preference' });
  await expect(ambientSnow).toHaveAttribute('data-state', 'running');

  await page.emulateMedia({ forcedColors: 'active' });
  await expect(perimeter).toHaveCSS('display', 'none');
  await page.emulateMedia({ forcedColors: 'none' });
  await expect(ambientSnow).toHaveAttribute('data-state', 'running');

  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  await expect.poll(visualState).toMatchObject({
    snow: 'none',
    snowState: 'hidden',
    cap: 'none',
    backdrop: 'none',
    perimeter: 'none',
  });
  await session.send('Emulation.setEmulatedMedia', { features: [] });
  await expect(ambientSnow).toHaveAttribute('data-state', 'running');

  expect(
    await page.evaluate(() => {
      const findSlowUpdateRule = (rules: CSSRuleList): boolean =>
        [...rules].some((rule) => {
          if (
            rule instanceof CSSMediaRule &&
            rule.conditionText.includes('update: slow')
          ) {
            const slowRules = [...rule.cssRules].filter(
              (child): child is CSSStyleRule => child instanceof CSSStyleRule,
            );
            return slowRules.some(
              (child) =>
                child.selectorText.includes('.perimeter-light') &&
                child.style.display === 'none',
            );
          }
          return (
            rule instanceof CSSGroupingRule && findSlowUpdateRule(rule.cssRules)
          );
        });
      return [...document.styleSheets].some((sheet) =>
        findSlowUpdateRule(sheet.cssRules),
      );
    }),
  ).toBe(true);
  await session.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5,
  });
  await expect
    .poll(() => page.evaluate(() => matchMedia('(pointer: coarse)').matches))
    .toBe(true);
  await expect(perimeter).toHaveCSS('display', 'none');
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
});

test('covers required responsive widths with a concise header', async ({
  page,
}, testInfo) => {
  // Allow the full responsive interaction matrix without changing per-action timeouts.
  test.setTimeout(150_000);
  test.skip(
    !testInfo.project.name.includes('desktop'),
    'Desktop projects exercise every required width in both themes.',
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('link', { name: 'Workloads' }).click();
    const header = page.getByRole('banner');
    await expect(header.getByText('Leviathan', { exact: true })).toBeVisible();
    await expect(header).not.toContainText('local read-only');
    await expect(header).not.toContainText(/NVML|GPM|\d{1,2}:\d{2}:\d{2}/u);
    const desktopNavigation = page.getByRole('navigation', {
      name: 'Workbench views',
      exact: true,
    });
    const mobileNavigation = page.getByRole('navigation', {
      name: 'Mobile workbench views',
      exact: true,
    });
    await expect(page.getByRole('link', { name: 'Workloads' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const headerGeometry = await header.evaluate((element) => {
      const bounds = element.firstElementChild!.getBoundingClientRect();
      return { height: bounds.height, left: bounds.left, right: bounds.right };
    });
    expect(headerGeometry.left).toBeGreaterThanOrEqual(0);
    expect(headerGeometry.right).toBeLessThanOrEqual(width);
    if (width < 768) {
      expect(headerGeometry.height).toBe(56);
      await expect(
        header.getByText('synthetic-host', { exact: true }),
      ).toBeHidden();
      await expect(desktopNavigation).toHaveCount(0);
      await expect(mobileNavigation).toBeVisible();
      await expect(mobileNavigation.getByRole('link')).toHaveCount(4);
      const tabGeometry = await mobileNavigation.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          position: getComputedStyle(element).position,
          tabHeights: [...element.querySelectorAll('a')].map(
            (tab) => tab.getBoundingClientRect().height,
          ),
          tabWidths: [...element.querySelectorAll('a')].map(
            (tab) => tab.getBoundingClientRect().width,
          ),
          tabsInside: [...element.querySelectorAll('a')].every((tab) => {
            const tabBounds = tab.getBoundingClientRect();
            return tabBounds.left >= 0 && tabBounds.right <= window.innerWidth;
          }),
        };
      });
      expect(tabGeometry.position).toBe('fixed');
      expect(tabGeometry.bottom).toBeCloseTo(900, 0);
      expect(Math.min(...tabGeometry.tabHeights)).toBeGreaterThanOrEqual(48);
      expect(Math.min(...tabGeometry.tabWidths)).toBeGreaterThanOrEqual(60);
      expect(tabGeometry.tabsInside).toBe(true);
      await expect(page.getByTestId('desktop-live-sampling')).toBeHidden();
      await expect(page.getByTestId('mobile-live-sampling')).toBeVisible();
      await expect(
        header.getByRole('button', { name: /Use (light|dark) theme/ }),
      ).toBeVisible();
      await expect(
        header.getByRole('link', {
          name: 'Open Leviathan repository on GitHub',
        }),
      ).toBeVisible();
      await expect(page.getByTestId('process-card')).toHaveCount(0);
      await expect(page.getByTestId('process-scroll-viewport')).toHaveCount(0);
      await page.evaluate(
        (nextSettings) => {
          const source = (
            window as unknown as {
              __leviathanEventSource: {
                dispatchEvent: (event: Event) => boolean;
                onerror: ((event: Event) => void) | null;
                onopen: ((event: Event) => void) | null;
              };
            }
          ).__leviathanEventSource;
          source.dispatchEvent(
            new MessageEvent('settings', {
              data: JSON.stringify(nextSettings),
            }),
          );
          source.onopen?.(new Event('open'));
          source.onerror?.(new Event('error'));
        },
        { ...settings, samplingIntervalMs: 500 },
      );
      await expect(
        page.getByRole('button', {
          name: 'Reconnecting status, view updates 0.5s',
        }),
      ).toBeVisible();
      if (width <= 380) {
        await expect(page.locator('.mobile-status-name')).toBeHidden();
      }
    } else {
      expect(headerGeometry.height).toBe(64);
      await expect(
        header.getByText('synthetic-host', { exact: true }),
      ).toBeVisible();
      await expect(desktopNavigation).toBeVisible();
      await expect(desktopNavigation.getByRole('link')).toHaveCount(4);
      await expect(mobileNavigation).toHaveCount(0);
      await expect(page.getByTestId('desktop-live-sampling')).toBeVisible();
      await expect(page.getByTestId('mobile-live-sampling')).toBeHidden();
      await expect(page.getByTestId('process-scroll-viewport')).toHaveCount(0);
      await expect(page.getByTestId('process-card')).toHaveCount(0);
    }

    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(
      page
        .getByRole('region', { name: 'Host capacity' })
        .locator(':scope > [data-slot="snow-cap"]'),
    ).toHaveCount(0);

    await page.getByRole('link', { name: 'Resources' }).click();
    await expect(
      page.getByRole('heading', { name: 'Resources', exact: true, level: 1 }),
    ).toBeFocused({ timeout: 20_000 });
    await expect(page.locator('.gpu-full-chip-button')).toHaveCount(1);
    await expect(page.locator('.gpu-ci-button')).toHaveCount(1);
    const gpuControlFit = await page
      .locator('.gpu-instance-controls')
      .evaluateAll((groups) =>
        groups.every((group) => group.scrollWidth <= group.clientWidth + 1),
      );
    expect(gpuControlFit).toBe(true);
    await page.locator('.gpu-ci-button').focus();
    await expect(page.locator('.gpu-chip-summary')).toContainText(
      'Shared GI 0 memory',
    );

    await page
      .getByRole('button', { name: 'Open GPU 0 full GPU details' })
      .click();
    const detail = page.getByTestId('detail-sheet');
    await expect(detail).toBeVisible({ timeout: 20_000 });
    const detailGeometry = await detail.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      columns: getComputedStyle(
        element.querySelector<HTMLElement>(
          '[data-testid="detail-live-metrics"]',
        )!,
      ).gridTemplateColumns.split(' ').length,
      chartHeight: element
        .querySelector<HTMLElement>('[data-testid="detail-history-chart"]')!
        .getBoundingClientRect().height,
    }));
    if (width < 768) {
      expect(detailGeometry.width).toBeCloseTo(width, 0);
      expect(detailGeometry.columns).toBe(width < 640 ? 2 : 4);
      expect(detailGeometry.chartHeight).toBeCloseTo(176, 0);
    } else {
      expect(detailGeometry.width).toBeCloseTo(
        Math.min(Math.max(640, width * 0.68), 880, width - 32),
        0,
      );
      expect(detailGeometry.columns).toBe(width >= 1024 ? 5 : 4);
      expect(detailGeometry.chartHeight).toBeCloseTo(192, 0);
    }
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    await page.getByRole('link', { name: 'Workloads' }).click();
    const workloads = page.getByTestId('people-view');
    const ownerSelect = page.getByLabel('Select user');
    const ownerTabs = page.getByRole('tablist', { name: 'Users' });
    if (width < 1024) {
      await expect(ownerSelect).toBeVisible();
      await expect(ownerTabs).toBeHidden();
    } else {
      await expect(ownerSelect).toBeHidden();
      await expect(ownerTabs).toBeVisible();
    }
    await selectWorkloadOwner(page, 'synthetic-owner');
    await expect(page.getByTestId('person-card')).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: 'Telemetry', level: 4 }),
    ).toBeVisible();
    await expect(workloads).not.toContainText(
      'Device-scoped signals, not user usage.',
    );
    await expect(page.locator('.workload-telemetry-chart')).toHaveCount(7);
    const telemetryColumns = await workloads
      .locator('.workload-telemetry-grid')
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(' ').length,
      );
    expect(telemetryColumns).toBe(width >= 1024 ? 2 : 1);
    await expect(workloads).not.toContainText('Parent GI metrics');
    await expect(workloads).not.toContainText('Physical GPU metrics');
    await expect(workloads.getByText('Allocated', { exact: true })).toHaveCount(
      1,
    );
    await expect(workloads.getByText('Reserved', { exact: true })).toHaveCount(
      0,
    );
    const workloadColumns = await workloads
      .locator('.mobile-workload-metrics')
      .first()
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(' ').length,
      );
    expect(workloadColumns).toBe(2);
    await expect(
      workloads.locator('[data-metric-icon="gpu_activity"]').first(),
    ).toBeVisible();
    await expect(
      workloads.locator('[data-metric-icon="memory"]').first(),
    ).toBeVisible();

    const footer = page.locator('footer.app-footer');
    const mobileFooter = footer.locator('.mobile-footer-copy');
    const desktopFooter = footer.locator('.desktop-footer-copy');
    if (width < 768) {
      await expect(mobileFooter).toBeVisible();
      await expect(desktopFooter).toBeHidden();
      await expect(mobileFooter).toContainText(
        '⚔️ Intellisys Dragoons × Codex',
      );
      await expect(mobileFooter).toContainText('Leviathan v0.4.0');
      await page.evaluate(() =>
        window.scrollTo({ top: document.documentElement.scrollHeight }),
      );
      const [footerBox, navigationBox] = await Promise.all([
        footer.boundingBox(),
        mobileNavigation.boundingBox(),
      ]);
      expect(footerBox).not.toBeNull();
      expect(navigationBox).not.toBeNull();
      expect(
        navigationBox!.y - (footerBox!.y + footerBox!.height),
      ).toBeGreaterThanOrEqual(16);
    } else {
      await expect(desktopFooter).toBeVisible();
      await expect(mobileFooter).toBeHidden();
      await expect(desktopFooter).toContainText(
        'Built with ⚔️ by Intellisys Dragoons and Codex · Leviathan v0.4.0',
      );
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
  }
});

test('uses mobile-native tabs, compact charts, and a full-screen detail sheet', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-narrow-dark',
    'One narrow dark project covers the mobile-native composition.',
  );
  await page.setViewportSize({ width: 320, height: 800 });

  const mobileNavigation = page.getByRole('navigation', {
    name: 'Mobile workbench views',
    exact: true,
  });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.getByRole('link')).toHaveCount(4);
  await expect(
    page.getByRole('navigation', { name: 'Workbench views', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('synthetic-host', { exact: true })).toBeHidden();
  await expect(page.locator('.host-capacity-card')).toHaveCount(4);

  await expect.poll(() => alignedRequestCount(page)).toBe(7);
  for (const chartID of overviewChartIDs) {
    const chart = page.getByTestId(chartID);
    const legend = chart.locator('.mobile-chart-legend');
    const legendItems = legend.locator('.mobile-chart-legend-item');
    const seriesCount = Number(await legend.getAttribute('data-series-count'));
    await expect(legendItems).toHaveCount(seriesCount);
    await expect(
      chart.locator('.overview-series path.recharts-line-curve'),
    ).toHaveCount(seriesCount);
    const readableControls = await legend.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.right <= window.innerWidth &&
        [...element.querySelectorAll('button')].every((button) => {
          const control = button.getBoundingClientRect();
          return control.width <= bounds.width + 1 && control.height >= 44;
        })
      );
    });
    expect(readableControls).toBe(true);
  }

  await mobileNavigation.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Resources', level: 1 }),
  ).toBeFocused();
  const resourceGeometry = await page
    .locator('.gpu-card')
    .first()
    .evaluate((element) => ({
      controlsHeight: element
        .querySelector('.gpu-instance-controls')!
        .getBoundingClientRect().height,
      surfaceMinHeight: getComputedStyle(
        element.querySelector('.gpu-full-chip-button')!,
      ).minHeight,
      width: element.getBoundingClientRect().width,
    }));
  expect(resourceGeometry.controlsHeight).toBeGreaterThanOrEqual(44);
  expect(resourceGeometry.controlsHeight).toBeLessThanOrEqual(80);
  expect(
    Number.parseFloat(resourceGeometry.surfaceMinHeight),
  ).toBeLessThanOrEqual(144);
  expect(resourceGeometry.width).toBeLessThanOrEqual(288.5);

  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const sheet = page.getByTestId('detail-sheet');
  await expect(sheet).toBeVisible();
  const sheetGeometry = await sheet.evaluate((element) => {
    const close = element.querySelector<HTMLElement>(
      '[data-slot="sheet-close"]',
    )!;
    const bounds = element.getBoundingClientRect();
    const closeBounds = close.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.width,
      closeHeight: closeBounds.height,
      closeWidth: closeBounds.width,
      headerPosition: getComputedStyle(
        element.querySelector('.mobile-detail-sheet-header')!,
      ).position,
    };
  });
  expect(sheetGeometry.left).toBeCloseTo(0, 0);
  expect(sheetGeometry.right).toBeCloseTo(320, 0);
  expect(sheetGeometry.width).toBeCloseTo(320, 0);
  expect(sheetGeometry.closeHeight).toBeGreaterThanOrEqual(44);
  expect(sheetGeometry.closeWidth).toBeGreaterThanOrEqual(44);
  expect(sheetGeometry.headerPosition).toBe('sticky');
  const close = sheet.getByRole('button', { name: 'Close' });
  const closeBeforeScroll = await close.boundingBox();
  expect(closeBeforeScroll).not.toBeNull();
  await sheet.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => sheet.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(close).toBeVisible();
  const closeAfterScroll = await close.boundingBox();
  expect(closeAfterScroll).not.toBeNull();
  expect(closeAfterScroll!.y).toBeGreaterThanOrEqual(sheetGeometry.top);
  expect(closeAfterScroll!.y + closeAfterScroll!.height).toBeLessThanOrEqual(
    sheetGeometry.bottom,
  );
  expect(closeAfterScroll!.x).toBeCloseTo(closeBeforeScroll!.x, 0);
  await close.click();
  await expect(sheet).toBeHidden();

  for (const view of ['Workloads', 'Status', 'Overview']) {
    await mobileNavigation.getByRole('link', { name: view }).click();
    await expect(
      page.getByRole('heading', { name: view, exact: true, level: 1 }),
    ).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
  }
});

test('generated snow drifts remain stable through polling navigation and resizing and change with each page seed', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One project checks generated snow identity and theme gating.',
  );
  const collectCaps = () =>
    page.locator('.snow-capped > [data-slot="snow-cap"]').evaluateAll((caps) =>
      caps.map((cap) => ({
        key: cap.getAttribute('data-snow-surface'),
        profile: cap.getAttribute('data-snow-profile'),
        count: Number(cap.getAttribute('data-snow-piles')),
        bodies: [
          ...cap.querySelectorAll('[data-slot="snow-cap-body"] path'),
        ].map((path) => path.getAttribute('d')),
        shadows: cap.querySelectorAll('[data-slot="snow-cap-shadow"] path')
          .length,
        highlights: cap.querySelectorAll(
          '[data-slot="snow-cap-highlight"] path',
        ).length,
        layerCount: cap.parentElement!.querySelectorAll(
          ':scope > [data-slot="snow-cap"]',
        ).length,
      })),
    );
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  const initial = await collectCaps();
  expect(initial.length).toBeGreaterThan(1);
  expect(
    initial.every(
      ({ key, profile, count, bodies, shadows, highlights, layerCount }) =>
        Boolean(key) &&
        profile === 'generated' &&
        count >= 1 &&
        count <= 2 &&
        bodies.length === count &&
        shadows === count &&
        highlights === count &&
        layerCount === 1,
    ),
  ).toBe(true);
  expect(
    new Set(initial.map(({ bodies }) => JSON.stringify(bodies))).size,
  ).toBe(initial.length);
  const nextSnapshot = { ...snapshot, sequence: snapshot.sequence + 1 };
  await page.evaluate((next) => {
    (
      window as unknown as { __leviathanEventSource: EventTarget }
    ).__leviathanEventSource.dispatchEvent(
      new MessageEvent('snapshot', { data: JSON.stringify(next) }),
    );
  }, nextSnapshot);
  await expect.poll(collectCaps, { timeout: 20_000 }).toEqual(initial);
  for (const width of [320, 767, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(collectCaps, { timeout: 20_000 }).toEqual(initial);
    const visiblePaths = await page
      .locator('[data-slot="snow-cap-body"] path')
      .evaluateAll((paths) =>
        paths.every((path) => getComputedStyle(path).display !== 'none'),
      );
    expect(visiblePaths).toBe(true);
  }
  await page.getByRole('link', { name: 'Workloads' }).click();
  const workloads = await collectCaps();
  expect(workloads.every(({ count }) => count >= 1 && count <= 2)).toBe(true);
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect.poll(collectCaps, { timeout: 20_000 }).toEqual([]);
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect.poll(collectCaps, { timeout: 20_000 }).toEqual(initial);
  await page.reload();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  await expect.poll(collectCaps, { timeout: 20_000 }).toEqual(initial);
  await page.evaluate(() =>
    sessionStorage.setItem('leviathan.test-snow-seed', '723991'),
  );
  await page.reload();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  const changed = await collectCaps();
  expect(changed.map(({ bodies }) => bodies)).not.toEqual(
    initial.map(({ bodies }) => bodies),
  );
  await page.getByRole('button', { name: 'Use light theme' }).click();
  for (const cap of await page.locator('.snow-cap').all())
    await expect(cap).toBeHidden();
});

test('unseeded page loads generate fresh accumulated snow', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One project verifies production-style per-page randomness.',
  );
  await page.evaluate(() =>
    sessionStorage.setItem('leviathan.test-snow-seed', 'random'),
  );
  await page.goto('/#resources');
  await page.reload();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  const paths = () =>
    page
      .locator('.gpu-card [data-slot="snow-cap-body"] path')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('d')),
      );
  const first = await paths();
  expect(first.length).toBeGreaterThanOrEqual(2);
  expect(first.length).toBeLessThanOrEqual(4);
  await page.reload();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  expect(await paths()).not.toEqual(first);
});

test('matches targeted workbench and frost-dragon visual baselines', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('gpu-activity-chart')).toBeVisible();
  await expect(
    page.getByTestId('host-storage-chart').locator('.recharts-wrapper'),
  ).toBeVisible();
  const project = testInfo.project.name;
  const capturePage = async (name: string) => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page).toHaveScreenshot(name, {
      animations: 'disabled',
      timeout: 20_000,
      fullPage: true,
      maxDiffPixelRatio: 0.002,
    });
  };
  const captureViewport = (name: string) =>
    expect(page).toHaveScreenshot(name, {
      animations: 'disabled',
      timeout: 20_000,
      fullPage: false,
      maxDiffPixels: 32,
    });
  const showAllocatedWorkloads = async () => {
    await page.getByRole('link', { name: 'Workloads' }).click();
    await selectWorkloadOwner(page, 'synthetic-owner');
    await expect(page.locator('.workload-telemetry-chart')).toHaveCount(7);
    await expect(
      page.locator('.workload-telemetry-chart .recharts-wrapper').first(),
    ).toBeVisible();
  };
  const openFullGPUDetail = async () => {
    await selectWorkloadOwner(page, 'synthetic-owner');
    await page
      .getByRole('button', {
        name: /^Open GPU \d+ · Full GPU details$/u,
      })
      .click();
    const detail = page.getByTestId('detail-sheet');
    await expect(detail).toBeVisible();
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBe(0);
  };
  const closeDetail = async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('detail-sheet')).toBeHidden();
  };

  if (project === 'chromium-desktop-dark') {
    await capturePage('overview-dark.png');
    const tooltipChart = page
      .getByTestId('memory-chart')
      .locator('.recharts-wrapper')
      .first();
    await tooltipChart.scrollIntoViewIfNeeded();
    const tooltipChartBox = await tooltipChart.boundingBox();
    expect(tooltipChartBox).not.toBeNull();
    await page.mouse.move(
      tooltipChartBox!.x + tooltipChartBox!.width - 24,
      tooltipChartBox!.y + tooltipChartBox!.height / 2,
    );
    await expect(page.getByTestId('memory-chart-tooltip')).toBeVisible();
    await captureViewport('chart-tooltip-dark.png');
    await page.mouse.move(0, 0);
    await page.getByRole('link', { name: 'Resources' }).click();
    await page.addStyleTag({
      content: `
        .dark .flowing-surface:hover:not(:focus-within)
          > .perimeter-light .perimeter-light-glow {
          animation: none !important;
          opacity: 0.82 !important;
        }
      `,
    });
    const hoveredResource = page
      .getByRole('button', { name: 'Open GPU 0 full GPU details' })
      .locator('xpath=..');
    await hoveredResource.hover();
    await expect(hoveredResource).toHaveScreenshot(
      'resources-hover-border-dark.png',
      { animations: 'disabled' },
    );
    await page.mouse.move(0, 0);
    // A shared scroll-attached canvas renders visible scenes; capture the viewport
    // instead of stitching unrendered offscreen boards into a full-page image.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(page.locator('.gpu-board-view').first()).toHaveAttribute(
      'data-render-mode',
      'webgl',
    );
    await captureViewport('resources-desktop.png');
    await page
      .getByRole('region', { name: 'GPUs', exact: true })
      .evaluate(async (element) => {
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
    await expect(page.locator('.gpu-board-view').nth(1)).toHaveAttribute(
      'data-render-mode',
      'webgl',
    );
    await captureViewport('gpu-resources-desktop.png');
    await showAllocatedWorkloads();
    const hoveredWorkload = page
      .getByRole('button', {
        name: /^Open GPU \d+ · Full GPU details$/u,
      })
      .locator('xpath=..');
    await hoveredWorkload.hover();
    await captureViewport('workloads-resource-hover-dark.png');
    await page.mouse.move(0, 0);
    await capturePage('workloads-desktop-dark.png');
    await openFullGPUDetail();
    await captureViewport('detail-desktop-dark.png');
    await closeDetail();
  }
  if (project === 'chromium-desktop-light') {
    await capturePage('overview-frost-light.png');
    await showAllocatedWorkloads();
    await capturePage('workloads-desktop-light.png');
    await openFullGPUDetail();
    await captureViewport('detail-desktop-light.png');
    await closeDetail();
  }
  if (
    project === 'chromium-narrow-dark' ||
    project === 'chromium-narrow-light'
  ) {
    const theme = project.endsWith('light') ? 'light' : 'dark';
    await capturePage(`overview-mobile-${theme}.png`);
    await page.getByRole('link', { name: 'Resources' }).click();
    await captureViewport(`resources-narrow-${theme}.png`);
    const aboutMotherboard = page.getByLabel(
      'About this motherboard illustration',
    );
    await aboutMotherboard.click();
    await expect(page.locator('.motherboard-resources')).toHaveCSS(
      'isolation',
      'auto',
    );
    await expect(page.locator('.motherboard-resources')).toHaveCSS(
      'backdrop-filter',
      'none',
    );
    await expect(page.locator('.motherboard-about')).toHaveAttribute(
      'open',
      '',
    );
    await page.mouse.move(0, 0);
    await captureViewport(`resources-about-narrow-${theme}.png`);
    await aboutMotherboard.click();
    const isolatedBoardStyle = await page.addStyleTag({
      content:
        '.mobile-workbench-nav, .leviathan-header { visibility: hidden }',
    });
    try {
      await page.mouse.move(0, 0);
      await page.locator('.gpu-card').first().scrollIntoViewIfNeeded();
      await expect(page.locator('.gpu-board-view').first()).toHaveAttribute(
        'data-render-mode',
        'webgl',
      );
      await expect(page.locator('.gpu-card').first()).toHaveScreenshot(
        `gpu-board-mobile-${theme}.png`,
        { animations: 'disabled' },
      );
      await page.locator('.gpu-card').nth(1).scrollIntoViewIfNeeded();
      await expect(page.locator('.gpu-board-view').nth(1)).toHaveAttribute(
        'data-render-mode',
        'webgl',
      );
      await expect(page.locator('.gpu-card').nth(1)).toHaveScreenshot(
        `mig-board-mobile-${theme}.png`,
        { animations: 'disabled' },
      );
    } finally {
      await isolatedBoardStyle.evaluate((element) =>
        element.parentNode?.removeChild(element),
      );
    }
    await showAllocatedWorkloads();
    await captureViewport(`workloads-mobile-${theme}.png`);
    await openFullGPUDetail();
    await captureViewport(`detail-mobile-${theme}.png`);
    await closeDetail();
  }
  await page.getByRole('link', { name: 'Status' }).click();
  await expect(page.locator('.health-day')).toHaveCount(270);
  await capturePage(
    `diagnostics-${project.includes('narrow') ? 'mobile' : 'desktop'}-${project.endsWith('light') ? 'light' : 'dark'}.png`,
  );
  if (project.endsWith('desktop-dark') || project.endsWith('desktop-light')) {
    // Isolate branding from compositor state left by the GPU inspection journey.
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Status', exact: true, level: 1 }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId('leviathan-header-mark')).toHaveScreenshot(
      `frost-dragon-${project.endsWith('light') ? 'light' : 'dark'}.png`,
      { animations: 'disabled', maxDiffPixels: 1 },
    );
  }
});

test('whole-machine overview and persistent health remain useful on every theme', async ({
  page,
}) => {
  for (const id of [
    'host-cpu-chart',
    'host-ram-chart',
    'host-storage-chart',
    'gpu-activity-chart',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
    await expect(
      page.getByTestId(id).locator('.recharts-wrapper'),
    ).toBeVisible();
  }
  await expect(page.getByTestId('temperature-chart')).toBeVisible();
  const storage = page.getByTestId('host-storage-chart');
  await expect(storage.getByRole('radio', { name: 'I/O' })).toBeChecked();
  await storage.locator('.segmented-item', { hasText: 'Space' }).click();
  await expect(storage.getByRole('radio', { name: 'Space' })).toBeChecked();
  await expect(storage.getByText('100%', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Status' }).click();
  await expect(
    page.getByRole('heading', { name: 'Current status' }),
  ).toBeVisible();
  await expect(page.locator('.health-uptimes')).toContainText('2h 0m');
  await expect(page.locator('.health-uptimes')).toContainText('2d 1h');
  await expect(page.locator('.health-day')).toHaveCount(270);
  await expect(page.getByLabel('Inspect day')).toHaveCount(0);
  const timeline = page.getByRole('slider', {
    name: 'Host telemetry daily history',
  });
  await timeline.focus();
  await page.keyboard.press('Home');
  await expect(timeline).toHaveAttribute('aria-valuetext', /No data/);
  const blocking = (await new AxeBuilder({ page }).analyze()).violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  );
  expect(blocking).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test('whole-machine phone controls contain reconnecting text and health actions', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes('desktop'),
    'Desktop projects cover both themes at each extra phone width.',
  );
  for (const width of [390, 430, 640, 767]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(() => {
      const source = (
        window as unknown as {
          __leviathanEventSource: { onerror?: (event: Event) => void };
        }
      ).__leviathanEventSource;
      source.onerror?.(new Event('error'));
    });
    const trigger = page.locator('.mobile-status-trigger');
    await expect(trigger).toBeVisible();
    const fits = await trigger.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        fit: element.scrollWidth <= element.clientWidth,
        inside: bounds.right <= innerWidth,
      };
    });
    expect(fits.width).toBeGreaterThanOrEqual(44);
    expect(fits.height).toBeGreaterThanOrEqual(44);
    expect(fits.fit).toBe(true);
    expect(fits.inside).toBe(true);
    const ribbon = page.getByRole('region', { name: 'Active host health' });
    const button = ribbon.getByRole('button', { name: 'Status' });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await trigger.click();
    await expect(
      page.getByRole('dialog').getByText('synthetic-host'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('offscreen charts retain every half-second sample and catch up on inspection', async ({
  page,
}) => {
  const storage = page.getByTestId('host-storage-chart');
  const curve = storage.locator('.recharts-line-curve').first();
  await expect(curve).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(() =>
      storage.evaluate(
        (element) =>
          element.getBoundingClientRect().top > window.innerHeight + 160,
      ),
    )
    .toBe(true);
  // Let the intersection notification settle before taking the frozen SVG.
  await page.waitForTimeout(300);
  const frozen = await curve.getAttribute('d');
  for (const [index, value] of [1, 4, 9].entries()) {
    const next = structuredClone(snapshot);
    const time = new Date(
      Date.parse(sampledAt) + 5000 + index * 500,
    ).toISOString();
    next.sequence += index + 1;
    next.sampledAt = time;
    next.system.storage.sampledAt = time;
    next.system.storage.readBytesPerSecond = {
      ...next.system.storage.readBytesPerSecond,
      sampledAt: time,
      status: 'available',
      value: value * 1024 ** 2,
    };
    await page.evaluate((data) => {
      (
        window as unknown as { __leviathanEventSource: EventTarget }
      ).__leviathanEventSource.dispatchEvent(
        new MessageEvent('snapshot', { data: JSON.stringify(data) }),
      );
    }, next);
    // Live values and history ingestion continue even while the SVG is frozen.
    await expect(storage.locator('[data-legend-value]').first()).toHaveText(
      `${value} MiB/s`,
    );
    expect(await curve.getAttribute('d')).toBe(frozen);
  }
  await storage.scrollIntoViewIfNeeded();
  await expect(curve).not.toHaveAttribute('d', frozen!);
  await storage.locator('figure').focus();
  await page.keyboard.press('End');
  // The existing five-second trend must include all three offscreen samples,
  // not just the most recent one: (1 + 4 + 9) / 3 = 4.67 MiB/s.
  await expect(storage.locator('[data-legend-value]').first()).toHaveText(
    '4.67 MiB/s',
  );
  await page.keyboard.press('ArrowLeft');
  await expect(storage.locator('[data-legend-value]').first()).toHaveText(
    '180 MiB/s',
  );
  await page.keyboard.press('Escape');
  await expect(storage.locator('[data-legend-value]').first()).toHaveText(
    '9 MiB/s',
  );
});

test('whole-machine history is inspectable directly by keyboard and touch', async ({
  page,
}) => {
  const cpu = page.getByTestId('host-cpu-chart');
  const plot = cpu.locator('figure');
  await expect(plot.locator('.recharts-wrapper')).toBeVisible();
  await expect(page.getByText('Inspect history', { exact: true })).toHaveCount(
    0,
  );
  await plot.focus();
  await page.keyboard.press('Home');
  const first = await cpu.locator('.chart-selection-readout').innerText();
  await page.keyboard.press('End');
  await expect(cpu.locator('.chart-selection-readout')).not.toHaveText(first);
  await expect(
    cpu.getByRole('button', { name: 'Return CPU to live values' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    cpu.getByRole('button', { name: 'Return CPU to live values' }),
  ).toHaveCount(0);
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5,
  });
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(
    cpu.getByRole('button', { name: 'Return CPU to live values' }),
  ).toBeVisible();
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.getByRole('link', { name: 'Resources' }).click();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const detail = page.getByTestId('detail-sheet');
  const detailPlot = detail.locator('figure').first();
  await expect(detailPlot.locator('.recharts-wrapper')).toBeVisible();
  await detailPlot.focus();
  await page.keyboard.press('Home');
  await expect(
    detail.getByRole('button', {
      name: 'Return Resource activity to live values',
    }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail).toBeVisible();
  await expect(
    detail.getByRole('button', {
      name: 'Return Resource activity to live values',
    }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
});

test('whole-machine assignment states remain explicit without a process panel', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes('desktop'),
    'Both themes cover integration states.',
  );
  const publish = (payload: unknown) =>
    page.evaluate((data) => {
      (
        window as unknown as { __leviathanEventSource: EventTarget }
      ).__leviathanEventSource.dispatchEvent(
        new MessageEvent('snapshot', { data: JSON.stringify(data) }),
      );
    }, payload);
  let sequence = snapshot.sequence;
  await page.getByRole('link', { name: 'Workloads' }).click();
  for (const state of ['stale', 'unavailable', 'unconfigured']) {
    await publish({
      ...snapshot,
      sequence: ++sequence,
      attribution:
        state === 'unconfigured'
          ? undefined
          : { ...snapshot.attribution, status: state },
    });
    await expect(
      page.getByTestId(
        state === 'unconfigured'
          ? 'people-attribution-unconfigured'
          : 'people-attribution-state',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('process-section')).toHaveCount(0);
  }
  await publish({
    ...snapshot,
    sequence: ++sequence,
    gpus: [],
    processes: [],
    capabilities: {
      ...snapshot.capabilities,
      nvml: {
        ...snapshot.capabilities.nvml,
        available: false,
        status: 'unsupported',
      },
    },
  });
  await page.getByRole('link', { name: 'Overview' }).click();
  const capacity = page.getByRole('region', { name: 'Host capacity' });
  await expect(capacity.getByText('GPU discovery unavailable')).toBeVisible();
  await expect(
    capacity.getByRole('button', { name: 'Inspect CPU resources' }),
  ).toContainText('32');
  await expect(page.getByRole('button', { name: /^GPU details/u })).toHaveCount(
    0,
  );
});

test('whole-machine layouts retain readable controls at 200 percent text size', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  test.skip(
    !testInfo.project.name.includes('desktop'),
    'Both desktop projects exercise enlarged text at phone widths.',
  );
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ['Overview', 'Resources', 'Workloads', 'Status']) {
      // A reload restores the original font sizes before the next measurement.
      await page.goto(`/#${view.toLowerCase()}`);
      await page.reload();
      await expect(
        page.getByRole('heading', { name: view, level: 1 }),
      ).toBeVisible();
      if (view === 'Overview') {
        await expect(page.locator('.recharts-wrapper')).toHaveCount(9);
      }
      if (view === 'Workloads') {
        await selectWorkloadOwner(page, 'synthetic-owner');
        await expect(page.locator('.workload-telemetry-chart')).toHaveCount(7);
        // This legacy fixture has GPU readings but no owner cgroup measurements.
        await expect(
          page.locator('.workload-telemetry-chart .recharts-wrapper'),
        ).toHaveCount(4);
      }
      if (view === 'Status') {
        await expect(page.locator('.health-day')).toHaveCount(270);
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        // Enlarge text only: changing layout rem units would mask cramped controls.
        const fonts = [
          ...document.body.querySelectorAll<HTMLElement | SVGElement>('*'),
        ].map(
          (element) =>
            [element, parseFloat(getComputedStyle(element).fontSize)] as const,
        );
        for (const [element, size] of fonts) {
          element.style?.setProperty('font-size', `${size * 2}px`, 'important');
        }
      });
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.documentElement.scrollWidth - innerWidth,
            ),
          {
            message: `${view} at ${width}px must fit with 200% text`,
          },
        )
        .toBeLessThanOrEqual(0);
      const navigation = page.getByRole('navigation', {
        name: 'Mobile workbench views',
      });
      const links = await navigation.getByRole('link').evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          const textBounds: DOMRect[] = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            textBounds.push(range.getBoundingClientRect());
          }
          return {
            inside: bounds.left >= 0 && bounds.right <= innerWidth,
            // Decorative perimeter light extends 2px beyond the control.
            readable: textBounds.every(
              (text) => text.left >= bounds.left && text.right <= bounds.right,
            ),
            height: bounds.height,
          };
        }),
      );
      expect(links).toHaveLength(4);
      for (const link of links) {
        expect(link.inside).toBe(true);
        expect(link.readable).toBe(true);
        expect(link.height).toBeGreaterThanOrEqual(44);
      }
      const clipped = await page
        .locator(
          '.host-capacity-card, .assignment-status, [data-testid="process-card"] dl, .health-history-heading',
        )
        .evaluateAll((elements) =>
          elements
            .filter((element) => element.scrollWidth > element.clientWidth)
            .map((element) => element.getAttribute('class')),
        );
      expect(clipped, `${view} controls must contain enlarged text`).toEqual(
        [],
      );
      // Tick labels must stay inside the SVG even when the plot becomes narrower.
      await expect
        .poll(
          () =>
            page
              .locator('.recharts-cartesian-axis-tick text')
              .evaluateAll((elements) =>
                elements
                  .filter((element) => {
                    const bounds = element.getBoundingClientRect();
                    const svg = element.closest('svg')?.getBoundingClientRect();
                    return (
                      svg &&
                      bounds.width > 0 &&
                      (bounds.left < svg.left - 1 ||
                        bounds.right > svg.right + 1 ||
                        bounds.top < svg.top - 1 ||
                        bounds.bottom > svg.bottom + 1)
                    );
                  })
                  .map((element) => element.textContent),
              ),
          {
            message: `${view} chart labels must fit at ${width}px`,
          },
        )
        .toEqual([]);
    }
  }
});

test('aligns compact capacity rows and exposes direct mobile actions', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes('desktop'),
    'Both themes cover every width.',
  );
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.fonts.ready);
  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const cards = page.locator('.host-capacity-card');
    await expect(cards).toHaveCount(4);
    const geometry = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        const slots = [
          '.host-capacity-label',
          '.host-capacity-value',
          '.host-capacity-unit',
          '.host-capacity-detail',
          '[data-slot="progress-track"], .gpu-allocation-bar',
        ];
        return {
          top: box.top,
          height: box.height,
          left: box.left,
          right: box.right,
          rows: slots.map(
            (selector) =>
              element.querySelector(selector)!.getBoundingClientRect().top,
          ),
          barHeight: element.querySelector(slots[4])!.getBoundingClientRect()
            .height,
          bottomInset:
            box.bottom -
            element.querySelector(slots[4])!.getBoundingClientRect().bottom,
        };
      }),
    );
    for (const card of geometry) {
      expect(card.left).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(width);
      expect(card.barHeight).toBe(4);
      expect(card.bottomInset).toBeLessThanOrEqual(17);
      for (const sibling of geometry.filter(
        (other) => Math.abs(other.top - card.top) < 1,
      )) {
        expect(card.height).toBeCloseTo(sibling.height, 0);
        card.rows.forEach((top, index) =>
          expect(top).toBeCloseTo(sibling.rows[index], 0),
        );
      }
    }
    await expect(
      page.locator('.host-capacity-footnote, .gpu-allocation-legend'),
    ).toHaveCount(0);
    await expect(cards.locator('[data-gpu-brand]')).toHaveCount(0);
    await expect(cards.locator('.lucide-gauge')).toHaveCount(1);
    const header = page.getByRole('banner');
    await expect(
      header.getByRole('button', { name: 'Open app menu' }),
    ).toHaveCount(0);
    for (const control of [
      header.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
      header.getByRole('button', { name: /Use (light|dark) theme/ }),
    ]) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    if (width < 768) {
      await header
        .getByRole('button', { name: /Live status, view updates/ })
        .click();
      const popup = page.getByRole('dialog');
      await expect(popup).toBeVisible();
      await expect(popup).not.toContainText(
        /This browser updates|Host samples|profiles|processes/,
      );
      await expect(popup.getByText('synthetic-host')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(
        header.getByRole('button', { name: /Live status, view updates/ }),
      ).toBeFocused();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await expect(
    page.getByTestId('gpu-activity-chart').locator('.lucide-gauge'),
  ).toHaveCount(1);
});
