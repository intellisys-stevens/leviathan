import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

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
    nvml: { name: 'Synthetic NVML', available: true, status: 'available' },
    gpm: { name: 'Synthetic GPM', available: true, status: 'available' },
    dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
    proc: { name: '/proc', available: true, status: 'available' },
    profileMetrics: true,
  },
  diagnostics: [],
  attribution: {
    provider: 'kubernetes_dra',
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
  samplingIntervalMs: 1_000,
  profileIntervalMs: 2_000,
  processIntervalMs: 2_000,
  historyWindowMs: 3_600_000,
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
  { injectAlignedGap = false }: { injectAlignedGap?: boolean } = {},
) {
  const state: SyntheticBackendState = {
    alignedRequests: 0,
    injectAlignedGap,
  };
  backendStates.set(page, state);

  await page.addInitScript(() => {
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
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        Object.defineProperty(window, '__leviathanEventSource', {
          configurable: true,
          value: this,
        });
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }

      close() {}
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: StableEventSource,
    });
  });

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/snapshot') {
      await route.fulfill({ json: snapshot });
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
        json: { version: '0.3.2', commit: 'synthetic', buildDate: sampledAt },
      });
      return;
    }
    if (url.pathname === '/api/v1/history') {
      await route.fulfill({
        json: {
          entity: url.searchParams.get('entity') ?? gpuUUID,
          metrics: (url.searchParams.get('metrics') ?? '').split(','),
          window: url.searchParams.get('window') ?? '30m',
          points: historyPoints,
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
      const points = historyPoints.map((point, pointIndex) => ({
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
  }, theme);
  await installSyntheticBackend(page, {
    injectAlignedGap: testInfo.title.includes('explicit missing sample'),
  });
  const directOperations = testInfo.title.includes('direct Operations');
  await page.goto(directOperations ? '/#operations' : '/#overview');
  await expect(
    page.getByRole('heading', {
      name: directOperations ? 'Operations' : 'Overview',
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
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
    await page.getByRole('button', { name: 'Open app menu' }).click();
    await expect(
      page.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
    await page.keyboard.press('Escape');
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
    const snowCap = getComputedStyle(
      document.querySelector('.snow-capped')!,
      '::after',
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
      snowCapBackground: snowCap.backgroundImage,
      snowCapAnimation: snowCap.animationName,
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
  if (!light) {
    expect(visual.snowCapBackground).not.toBe('none');
  }
  expect(visual.snowCapAnimation).toBe('none');
  expect(visual.cardRail).not.toBe('none');
  expect(visual.cardRadius).toBeLessThanOrEqual(8);
  expect(visual.cardBackdrop).toContain('blur');
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

  const firstFrame = await canvasFrameSignature(canvas);
  await expect
    .poll(() => canvasFrameSignature(canvas), {
      intervals: [80, 120, 180],
      timeout: 3_000,
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
      intervals: [80, 120, 180],
      timeout: 3_000,
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

  for (const width of [320, 360, 768, 1280, 1440]) {
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
  await expect.poll(() => alignedRequestCount(page)).toBe(5);

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

test('keeps closed trend geometry stable while the live bucket updates', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One desktop project verifies immutable closed trend buckets.',
  );
  await expect.poll(() => alignedRequestCount(page)).toBe(5);

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
  await expect.poll(() => alignedRequestCount(page)).toBe(5);

  const assertFloatingTooltip = async (
    frame: Locator,
    tooltipTestId: string,
  ) => {
    const chart = frame.locator('.recharts-wrapper').first();
    await expect(chart).toBeVisible();
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
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const detail = page.getByTestId('detail-sheet');
  await expect(
    detail.getByRole('list', { name: 'Activity chart series' }),
  ).toContainText('%');
  await detail
    .getByTestId('detail-history-chart')
    .locator('.recharts-wrapper')
    .click();
  await expect(page.locator('.chart-tooltip-portal')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const workloadActivity = page.locator('[data-workload-metric="activity"]');
  await expect(workloadActivity.getByRole('list')).toContainText('%');
  await workloadActivity.locator('.recharts-wrapper').click();
  await expect(page.locator('.chart-tooltip-portal')).toHaveCount(0);
});

test('renders an explicit missing sample as separated path segments', async ({
  page,
}) => {
  await expect.poll(() => alignedRequestCount(page)).toBe(5);

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
  const topology = page.getByRole('region', { name: 'GPU topology' });
  const cards = topology.locator('.gpu-card');
  await expect(cards).toHaveCount(2);
  const fullMetrics = page.getByRole('region', {
    name: 'GPU 0 live telemetry',
  });
  const metricTiles = fullMetrics.locator('.full-gpu-metric-tile');
  await expect(metricTiles).toHaveCount(6);
  const metricLayout = await fullMetrics
    .locator('.full-gpu-metrics')
    .evaluate((element) => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      rows: new Set(
        [...element.children].map(
          (child) => Math.round(child.getBoundingClientRect().top * 10) / 10,
        ),
      ).size,
    }));
  expect(metricLayout.columns).toBe(page.viewportSize()!.width >= 768 ? 3 : 2);
  expect(metricLayout.rows).toBe(page.viewportSize()!.width >= 768 ? 2 : 3);
  const [first, second] = await Promise.all([
    cards.nth(0).boundingBox(),
    cards.nth(1).boundingBox(),
  ]);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  if (page.viewportSize()!.width >= 1280) {
    expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(first!.height - second!.height)).toBeLessThanOrEqual(1);
    expect(second!.x).toBeGreaterThan(first!.x + first!.width);
  } else {
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height + 15);
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

test('keeps the live cadence control concise and visually balanced', async ({
  page,
}) => {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const header = page.getByRole('banner');
  const desktop = page.getByTestId('desktop-live-sampling');
  const mobile = page.getByTestId('mobile-live-sampling');
  let samplingGroup = desktop.getByRole('radiogroup', {
    name: 'Sampling interval',
  });

  await expect(header.getByText('Leviathan', { exact: true })).toBeVisible();
  if (viewport!.width >= 768) {
    await expect(
      header.getByText('synthetic-host', { exact: true }),
    ).toBeVisible();
  } else {
    await expect(
      header.getByText('synthetic-host', { exact: true }),
    ).toBeHidden();
  }
  await expect(header).not.toContainText('local read-only');
  await expect(page.getByText(/NVML.*GPM/u)).toHaveCount(0);
  await expect(
    page.getByText('Physical GPU and MIG topology.', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('GPU and MIG topology.', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/^host\s*\//u)).toHaveCount(0);
  await expect(
    page.getByText(
      'History across this host; the resource view above does not filter these charts.',
      { exact: true },
    ),
  ).toHaveCount(0);

  if (viewport!.width >= 768) {
    await expect(desktop).toBeVisible();
    await expect(mobile).toBeHidden();
    await expect(desktop.getByText('Live', { exact: true })).toBeVisible();
    await expect(samplingGroup).toHaveClass(/\bsegmented-control\b/u);
    await expect(
      samplingGroup.getByRole('radio', { checked: true }),
    ).toHaveCount(1);
    await expect(
      samplingGroup.locator('.segmented-item[data-active="true"]'),
    ).toHaveCount(1);

    const geometry = await desktop
      .locator('[aria-label="Live status and sampling"]')
      .evaluate((element) => {
        const status = element.querySelector('output')!.getBoundingClientRect();
        const choices = element
          .querySelector('[role="radiogroup"]')!
          .getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return {
          width: bounds.width,
          centerDelta: Math.abs(
            status.top + status.height / 2 - (choices.top + choices.height / 2),
          ),
          outerBorderWidth: getComputedStyle(element).borderTopWidth,
        };
      });

    expect(geometry.width).toBeLessThanOrEqual(224);
    expect(geometry.centerDelta).toBeLessThanOrEqual(1);
    expect(geometry.outerBorderWidth).toBe('0px');
  } else {
    await expect(desktop).toBeHidden();
    await expect(mobile).toBeVisible();
    const trigger = mobile.getByRole('button', {
      name: 'Live status, sampling 1s',
    });
    await expect(trigger).toHaveText('Live · 1s');
    if (viewport!.width <= 380) {
      await expect(trigger.locator('.mobile-status-name')).toBeHidden();
    }
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(triggerBox!.width).toBeLessThan(120);

    await trigger.click();
    const popup = page.getByRole('dialog');
    await expect(popup).toBeVisible();
    samplingGroup = popup.getByRole('radiogroup', {
      name: 'Sampling interval',
    });
    await expect(samplingGroup).toHaveClass(/\bsegmented-control\b/u);
    await expect(
      samplingGroup.getByRole('radio', { checked: true }),
    ).toHaveCount(1);
  }

  const samplingItems = samplingGroup.locator('.segmented-item');
  await expect(samplingGroup.getByRole('radio')).toHaveCount(3);
  await expect(samplingItems).toHaveCount(3);
  const itemBoxes = await samplingItems.evaluateAll((items) =>
    items.map((item) => {
      const bounds = item.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width };
    }),
  );
  for (const box of itemBoxes) expect(box.width).toBeGreaterThanOrEqual(40);
  for (let index = 1; index < itemBoxes.length; index += 1) {
    expect(
      itemBoxes[index].left - itemBoxes[index - 1].right,
    ).toBeGreaterThanOrEqual(-0.01);
  }
  if (viewport!.width < 768) {
    const widths = itemBoxes.map(({ width }) => width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  }

  const halfSecond = samplingGroup.getByRole('radio', { name: '0.5s' });
  const halfSecondItem = samplingItems.filter({ hasText: /^0\.5s$/u });
  const beforeUpdate = await halfSecondItem.evaluate((element) => ({
    width: (element as HTMLElement).offsetWidth,
    height: (element as HTMLElement).offsetHeight,
  }));
  await halfSecondItem.click();
  await expect(halfSecondItem).toHaveText('0.5s');
  await expect(halfSecondItem.locator('svg')).toHaveCount(0);
  await expect(halfSecondItem.locator('.animate-spin')).toHaveCount(0);
  await expect(halfSecond).toBeChecked();
  const duringUpdate = await halfSecondItem.evaluate((element) => ({
    width: (element as HTMLElement).offsetWidth,
    height: (element as HTMLElement).offsetHeight,
  }));
  expect(duringUpdate).toEqual(beforeUpdate);

  await expect(page.getByText('Sampling', { exact: true })).toHaveCount(0);
});

test('uses one smooth segmented-control motion contract for cadence and chart windows', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One desktop project verifies shared control geometry and independence.',
  );
  const sampling = page
    .getByTestId('desktop-live-sampling')
    .getByRole('radiogroup', { name: 'Sampling interval' });
  const telemetryHeader = page
    .getByRole('heading', { name: 'Telemetry', exact: true, level: 2 })
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
  const [samplingMotion, chartMotion] = await Promise.all([
    motion(sampling),
    motion(chartWindow),
  ]);
  expect(samplingMotion.duration).toBe('0.2s');
  expect(chartMotion.duration).toBe(samplingMotion.duration);
  expect(chartMotion.property).toContain('transform');
  expect(chartMotion.timing).toBe(samplingMotion.timing);

  const initialTransform = chartMotion.transform;
  await chartWindow.locator('.segmented-item', { hasText: /^15m$/u }).click();
  await expect(chartWindow.getByRole('radio', { name: '15m' })).toBeChecked();
  await expect(sampling.getByRole('radio', { name: '1s' })).toBeChecked();
  await expect
    .poll(async () => (await motion(chartWindow)).transform)
    .not.toBe(initialTransform);
});

test('bounds the process table with sticky headers and a scroll viewport', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Operations' }).click();
  const processSection = page.getByTestId('process-section');
  if (page.viewportSize()!.width < 768) {
    const cards = page.getByTestId('process-card');
    await expect(cards).toHaveCount(syntheticProcessCount);
    await cards.first().getByText('Executable and command').click();
    await expect(cards.first().getByText('/usr/bin/python3')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    return;
  }
  const viewport = page.getByTestId('process-scroll-viewport');
  const search = page.getByLabel('Filter GPU processes');
  await processSection.scrollIntoViewIfNeeded();
  await expect(page.getByText(/CUDA clients/u)).toHaveCount(0);
  await expect(page.getByText(/current PID namespace/u)).toHaveCount(0);
  await expect(page.getByText(/not workspace-attributed/u)).toHaveCount(0);
  await expect(
    viewport.getByRole('columnheader', { name: 'Workspace' }),
  ).toBeVisible();
  await expect(
    viewport.getByText('synthetic-owner / synthetic-training'),
  ).toHaveCount(6);
  await expect(
    page.getByText('opaque-synthetic-workspace-reference'),
  ).toHaveCount(0);
  await expect(viewport).toBeVisible();

  const dimensions = await viewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    containsSearch: element.contains(
      document.querySelector('[aria-label="Filter GPU processes"]'),
    ),
  }));
  expect(dimensions.clientHeight).toBeLessThanOrEqual(
    page.viewportSize()!.width >= 768 ? 384 : 352,
  );
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  expect(dimensions.containsSearch).toBe(false);

  const firstHeader = viewport.locator('thead th').first();
  await expect(firstHeader).toHaveCSS('position', 'sticky');
  await expect(firstHeader).toHaveCSS('top', '0px');

  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(search).toBeVisible();

  const lastRow = viewport.locator('tbody tr').last();
  const [viewportBox, rowBox] = await Promise.all([
    viewport.boundingBox(),
    lastRow.boundingBox(),
  ]);
  expect(viewportBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(
    viewportBox!.y + viewportBox!.height + 1,
  );
  expect(rowBox!.y).toBeGreaterThanOrEqual(viewportBox!.y - 1);

  await search.fill('synthetic-training');
  await expect(viewport.locator('tbody tr')).toHaveCount(6);
  await search.fill('');
});

test('switches workbench views without reloading charts or clearing process filters', async ({
  page,
}) => {
  await expect.poll(() => alignedRequestCount(page)).toBe(5);
  await page.getByRole('link', { name: 'Operations' }).click();
  const filter = page.getByLabel('Filter GPU processes');
  await filter.fill('synthetic-user-17');
  if (page.viewportSize()!.width >= 768) {
    await expect(
      page.getByTestId('process-scroll-viewport').locator('tbody tr'),
    ).toHaveCount(1);
  } else {
    await expect(page.getByTestId('process-card')).toHaveCount(1);
  }

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
  await expect(peopleView.getByText(/^(?:allocated|reserved)$/iu)).toHaveCount(
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
    page.getByRole('heading', { name: 'Assigned telemetry', level: 4 }),
  ).toBeVisible();
  await expect(page.locator('.workload-telemetry-chart')).toHaveCount(4);
  await expect.poll(() => alignedRequestCount(page)).toBe(6);

  await selectWorkloadOwner(page, 'second-synthetic-owner');
  await expect(page.getByTestId('person-card')).toContainText(
    'synthetic-inference',
  );
  await expect(
    page.getByRole('button', { name: 'Open GPU 1 · GI 0 · CI 0 details' }),
  ).toBeVisible();
  await expect(page.getByTestId('person-card')).toContainText(
    'No allocated GPU telemetry.',
  );
  await expect.poll(() => alignedRequestCount(page)).toBe(6);

  await selectWorkloadOwner(page, 'synthetic-owner');
  await expect(page.locator('.workload-telemetry-chart')).toHaveCount(4);
  await expect.poll(() => alignedRequestCount(page)).toBe(6);

  await expect(page.getByTestId('process-section')).toHaveCount(0);
  await expect(page.getByTestId('temperature-chart')).toHaveCount(0);
  await expect.poll(() => alignedRequestCount(page)).toBe(6);

  await page.getByRole('link', { name: 'Resources' }).click();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const detail = page.getByTestId('detail-sheet');
  await expect(detail).toBeVisible();
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

  await page.getByRole('button', { name: /GI 0 \/ CI 0/u }).click();
  await expect(detail).toBeVisible();
  await expect(
    detail.getByText('synthetic · gpu_instance · available', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Filter GPU processes')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toBeHidden();

  await page.getByRole('link', { name: 'Operations' }).click();
  await expect(page.getByLabel('Filter GPU processes')).toHaveValue(
    'synthetic-user-17',
  );
  if (page.viewportSize()!.width >= 768) {
    await expect(
      page.getByTestId('process-scroll-viewport').locator('tbody tr'),
    ).toHaveCount(1);
  } else {
    await expect(page.getByTestId('process-card')).toHaveCount(1);
  }
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('region', { name: 'GPU topology' }),
  ).toBeVisible();
  await expect.poll(() => alignedRequestCount(page)).toBe(6);
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
    expect(sheetGeometry.chartHeight).toBeCloseTo(216, 0);
  } else {
    const expectedWidth = Math.min(
      Math.max(640, viewport.width * 0.68),
      880,
      viewport.width - 32,
    );
    expect(sheetGeometry.width).toBeCloseTo(expectedWidth, 0);
    expect(sheetGeometry.metricColumns).toBe(5);
    expect(sheetGeometry.chartHeight).toBeCloseTo(224, 0);
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
    page.getByTestId('detail-sheet').getByRole('table', {
      name: '30m PCIe transfer history data summary',
      includeHidden: true,
    }),
  ).toBeAttached();
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

test('direct Operations loads avoid history requests and chart initialization', async ({
  page,
}) => {
  await expect(
    page.getByRole('heading', { name: 'Operations', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Processes', exact: true, level: 2 }),
  ).toBeVisible();
  await expect(page.getByTestId('process-section')).toBeVisible();
  const [processesBox, diagnosticsBox] = await Promise.all([
    page
      .getByRole('heading', { name: 'Processes', exact: true, level: 2 })
      .boundingBox(),
    page
      .getByRole('heading', { name: 'Diagnostics', exact: true, level: 2 })
      .boundingBox(),
  ]);
  expect(processesBox).not.toBeNull();
  expect(diagnosticsBox).not.toBeNull();
  expect(diagnosticsBox!.y).toBeGreaterThan(processesBox!.y);
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
  for (const view of ['Resources', 'Workloads', 'Operations', 'Overview']) {
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
    page.getByRole('heading', { name: 'Operations', level: 1 }),
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
  for (const view of ['Overview', 'Resources', 'Workloads', 'Operations']) {
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
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One desktop project covers browser-native hash and history scrolling.',
  );

  const scrollOverview = async () => {
    const offset = await page.evaluate(() => {
      window.scrollTo(0, 700);
      return window.scrollY;
    });
    expect(offset).toBeGreaterThan(100);
  };
  const expectViewTop = async (heading: string) => {
    await expect(
      page.getByRole('heading', { name: heading, exact: true, level: 1 }),
    ).toBeFocused();
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

test('balances attribution with exactly three overview totals', async ({
  page,
}) => {
  const summary = page.getByRole('region', { name: 'Host summary' });
  const totals = summary.locator('.summary-link');

  await expect(totals).toHaveCount(3);
  const expectedLabels =
    page.viewportSize()!.width < 768
      ? ['GPUs', 'Instances', 'Processes']
      : ['Physical GPUs', 'GPU instances', 'GPU processes'];
  for (const label of expectedLabels) {
    await expect(summary.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(
    summary.getByText('Compute instances', { exact: true }),
  ).toHaveCount(0);

  const widths = await totals.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  const columnCount = await summary
    .locator('.overview-kpi-grid')
    .evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length,
    );
  expect(columnCount).toBe(3);
});

test('redirects legacy operations hashes and preserves section focus', async ({
  page,
}) => {
  await page.goto('/#processes');
  await expect(page).toHaveURL(/#operations$/u);
  await expect(
    page.getByRole('heading', { name: 'Processes', exact: true, level: 2 }),
  ).toBeFocused();
  await expect(page.getByRole('link', { name: 'Operations' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.evaluate(() => {
    window.location.hash = '#diagnostics';
  });
  await expect(page).toHaveURL(/#operations$/u);
  await expect(
    page.getByRole('heading', { name: 'Diagnostics', exact: true, level: 2 }),
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

  await page.getByRole('link', { name: 'Operations' }).click();
  await expect(
    page.getByRole('heading', { name: 'Operations', level: 1 }),
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

test('opens resource details from card whitespace with one full-surface button', async ({
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

  await activateWhitespace('Open GPU 0 full GPU details');
  await activateWhitespace(/Open GPU 1 · GI 0 \/ CI 0 details/u);

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  await activateWhitespace(/^Open GPU \d+ · Full GPU details$/u);
});

test('keeps equal-size resource hover shadows and an independent focus ring', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes('narrow'),
    'Desktop light and dark projects verify the shared hover geometry.',
  );
  await page.getByRole('link', { name: 'Resources' }).click();
  const button = page.getByRole('button', {
    name: 'Open GPU 0 full GPU details',
  });
  const surface = button.locator('xpath=..');
  await surface.hover();
  await expect
    .poll(() =>
      surface.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .toContain('0px 20px 52px');
  const hoverContainment = await surface.evaluate((element) => {
    const card = element.closest<HTMLElement>('.gpu-card')!;
    return {
      cardContentVisibility: getComputedStyle(card).contentVisibility,
      cardOverflow: getComputedStyle(card).overflow,
      zIndex: getComputedStyle(element).zIndex,
    };
  });
  expect(hoverContainment).toEqual({
    cardContentVisibility: 'visible',
    cardOverflow: 'visible',
    zIndex: '3',
  });

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
    .toContain('0px 20px 52px');
  await expect(page.locator('.workload-person-detail')).toHaveCSS(
    'overflow',
    'visible',
  );
});

test('has no serious or critical authored accessibility violations', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const view of ['Overview', 'Resources', 'Workloads', 'Operations']) {
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
  const resource = page.locator('.interactive-resource').first();
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
        document.querySelector('.interactive-resource')!,
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
  await expect
    .poll(() =>
      resource.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .toContain('0px 20px 52px');
  expect(motion.durationToken).toBe('240ms');
  if (!light) {
    await expect.poll(() => canvasFramesAreStable(ambientSnow)).toBe(true);
  }
});

test('removes ambient glass effects for visibility-oriented media preferences', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark desktop project covers the ambient media fallbacks.',
  );
  const ambientSnow = page.getByTestId('ambient-snow');
  const cap = page.locator('.snow-capped').first();

  const visualState = () =>
    page.evaluate(() => {
      const snow = document.querySelector('[data-testid="ambient-snow"]')!;
      const capped = document.querySelector('.snow-capped')!;
      const panel = document.querySelector('.frost-panel')!;
      return {
        snow: getComputedStyle(snow).display,
        snowState: (snow as HTMLElement).dataset.state,
        cap: getComputedStyle(capped, '::after').display,
        backdrop: getComputedStyle(panel).backdropFilter,
      };
    });

  await expect(ambientSnow).toBeVisible();
  await expect(cap).toBeVisible();
  await page.emulateMedia({ contrast: 'more' });
  await expect.poll(visualState).toMatchObject({
    snow: 'none',
    snowState: 'hidden',
    cap: 'none',
    backdrop: 'none',
  });
  await page.emulateMedia({ contrast: 'no-preference' });
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
  });
  await session.send('Emulation.setEmulatedMedia', { features: [] });
  await expect(ambientSnow).toHaveAttribute('data-state', 'running');
});

test('covers required responsive widths with a concise header', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark project exercises the additional layout breakpoints.',
  );

  for (const width of [320, 360, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('link', { name: 'Operations' }).click();
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
    await expect(
      page.getByRole('link', { name: 'Operations' }),
    ).toHaveAttribute('aria-current', 'page');
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
        header.getByRole('button', { name: 'Open app menu' }),
      ).toBeVisible();
      await expect(page.getByTestId('process-card')).toHaveCount(
        syntheticProcessCount,
      );
      await expect(page.getByTestId('process-scroll-viewport')).toHaveCount(0);
      await page.evaluate(
        (nextSettings) => {
          const source = (
            window as unknown as {
              __leviathanEventSource: {
                dispatchEvent: (event: Event) => boolean;
                onerror: ((event: Event) => void) | null;
              };
            }
          ).__leviathanEventSource;
          source.dispatchEvent(
            new MessageEvent('settings', {
              data: JSON.stringify(nextSettings),
            }),
          );
          source.onerror?.(new Event('error'));
        },
        { ...settings, samplingIntervalMs: 500 },
      );
      await expect(
        page.getByRole('button', {
          name: 'Reconnecting status, sampling 0.5s',
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
      await expect(page.getByTestId('process-scroll-viewport')).toBeVisible();
      await expect(page.getByTestId('process-card')).toHaveCount(0);
    }

    await page.getByRole('link', { name: 'Resources' }).click();
    const fullMetrics = page.locator('.full-gpu-metrics');
    await expect(fullMetrics.locator('.full-gpu-metric-tile')).toHaveCount(6);
    const resourceColumns = await fullMetrics.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length,
    );
    expect(resourceColumns).toBe(width < 768 ? 2 : 3);
    const migMetrics = page.locator('.mobile-mig-block').first();
    await expect(
      migMetrics.locator('[data-metric-icon="memory"]'),
    ).toBeVisible();
    await expect(
      migMetrics.locator('[data-metric-icon="sm_activity"]'),
    ).toBeVisible();

    await page
      .getByRole('button', { name: 'Open GPU 0 full GPU details' })
      .click();
    const detail = page.getByTestId('detail-sheet');
    await expect(detail).toBeVisible();
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
      expect(detailGeometry.columns).toBe(2);
      expect(detailGeometry.chartHeight).toBeCloseTo(216, 0);
    } else {
      expect(detailGeometry.width).toBeCloseTo(
        Math.min(Math.max(640, width * 0.68), 880, width - 32),
        0,
      );
      expect(detailGeometry.columns).toBe(width >= 1024 ? 5 : 4);
      expect(detailGeometry.chartHeight).toBeCloseTo(224, 0);
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
    await expect(page.locator('.workload-telemetry-chart')).toHaveCount(4);
    const telemetryColumns = await workloads
      .locator('.workload-telemetry-grid')
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(' ').length,
      );
    expect(telemetryColumns).toBe(width >= 1024 ? 2 : 1);
    await expect(workloads).not.toContainText('Parent GI metrics');
    await expect(workloads).not.toContainText('Physical GPU metrics');
    await expect(workloads.getByText(/^(?:allocated|reserved)$/iu)).toHaveCount(
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
      await expect(mobileFooter).toContainText('Leviathan v0.3.2');
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
        'Built with ⚔️ by Intellisys Dragoons and Codex · Leviathan v0.3.2',
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
  await expect(page.locator('.summary-link .mobile-only-label')).toHaveText([
    'GPUs',
    'Instances',
    'Processes',
  ]);

  await expect.poll(() => alignedRequestCount(page)).toBe(5);
  for (const chartID of overviewChartIDs) {
    const chart = page.getByTestId(chartID);
    const legend = chart.locator('.mobile-chart-legend');
    const legendItems = legend.locator('.mobile-chart-legend-item');
    const seriesCount = Number(await legend.getAttribute('data-series-count'));
    await expect(legendItems).toHaveCount(seriesCount);
    await expect(
      chart.locator('.overview-series path.recharts-line-curve'),
    ).toHaveCount(seriesCount);
    const columns = await legend.evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length,
    );
    expect(columns).toBe(2);
  }

  await mobileNavigation.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Resources', level: 1 }),
  ).toBeFocused();
  const resourceGeometry = await page
    .locator('.gpu-card')
    .first()
    .evaluate((element) => ({
      bodyMinHeight: getComputedStyle(
        element.querySelector('.mobile-resource-body')!,
      ).minHeight,
      surfaceMinHeight: getComputedStyle(
        element.querySelector('.mobile-resource-surface')!,
      ).minHeight,
      width: element.getBoundingClientRect().width,
    }));
  expect(resourceGeometry.bodyMinHeight).toBe('0px');
  expect(resourceGeometry.surfaceMinHeight).toBe('0px');
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

  for (const view of ['Workloads', 'Operations', 'Overview']) {
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

test('assigns stable varied snow caps without decorating the light theme', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark desktop project verifies deterministic cap variety.',
  );

  const collectCaps = () =>
    page.locator('.snow-capped[data-snow-cap]').evaluateAll((elements) =>
      elements.map((element) => ({
        key:
          element.getAttribute('data-testid') ??
          element.querySelector('h3')?.textContent?.trim() ??
          element.textContent?.slice(0, 24).trim() ??
          '',
        variant: element.getAttribute('data-snow-cap'),
      })),
    );

  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Resources', exact: true, level: 1 }),
  ).toBeFocused();
  const resourceCaps = await collectCaps();
  await page.getByRole('link', { name: 'Workloads' }).click();
  await expect(
    page.getByRole('heading', { name: 'Workloads', exact: true, level: 1 }),
  ).toBeFocused();
  const workloadCaps = await collectCaps();
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(
    page.getByRole('heading', { name: 'Overview', exact: true, level: 1 }),
  ).toBeFocused();
  const allCaps = [...resourceCaps, ...workloadCaps, ...(await collectCaps())];
  expect(
    new Set(allCaps.map(({ variant }) => variant)).size,
  ).toBeGreaterThanOrEqual(3);
  expect(
    allCaps.every(({ variant }) =>
      ['left', 'right', 'split', 'center', 'corner'].includes(variant ?? ''),
    ),
  ).toBe(true);

  await page.reload();
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Resources', exact: true, level: 1 }),
  ).toBeFocused();
  expect(await collectCaps()).toEqual(resourceCaps);

  await page.getByRole('button', { name: 'Use light theme' }).click();
  const capDisplay = await page
    .locator('.snow-capped[data-snow-cap]')
    .first()
    .evaluate((element) => getComputedStyle(element, '::after').content);
  expect(capDisplay).toBe('none');
});

test('matches targeted workbench and frost-dragon visual baselines', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('pcie-throughput-chart')).toBeVisible();
  const project = testInfo.project.name;
  const capturePage = (name: string) =>
    expect(page).toHaveScreenshot(name, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.002,
    });
  const captureViewport = (name: string) =>
    expect(page).toHaveScreenshot(name, {
      animations: 'disabled',
      fullPage: false,
    });
  const showAllocatedWorkloads = async () => {
    await page.getByRole('link', { name: 'Workloads' }).click();
    await selectWorkloadOwner(page, 'synthetic-owner');
    await expect(page.locator('.workload-telemetry-chart')).toHaveCount(4);
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
    await page
      .getByRole('button', { name: 'Open GPU 0 full GPU details' })
      .locator('xpath=..')
      .hover();
    await capturePage('resources-desktop.png');
    await showAllocatedWorkloads();
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
    await page.getByRole('link', { name: 'Resources' }).click();
    await captureViewport(`resources-narrow-${theme}.png`);
    await showAllocatedWorkloads();
    await captureViewport(`workloads-mobile-${theme}.png`);
    await openFullGPUDetail();
    await captureViewport(`detail-mobile-${theme}.png`);
    await closeDetail();
  }
  if (project === 'chromium-narrow-dark') {
    await page.getByRole('link', { name: 'Operations' }).click();
    await capturePage('operations-narrow.png');
  }
  if (project.endsWith('desktop-dark') || project.endsWith('desktop-light')) {
    await expect(page.getByTestId('leviathan-header-mark')).toHaveScreenshot(
      `frost-dragon-${project.endsWith('light') ? 'light' : 'dark'}.png`,
      { animations: 'disabled' },
    );
  }
});
