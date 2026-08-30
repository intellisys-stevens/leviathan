import { expect, test, type Page } from '@playwright/test';

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
      await route.fulfill({ json: settings });
      return;
    }
    if (url.pathname === '/api/v1/version') {
      await route.fulfill({
        json: { version: '0.2.0', commit: 'synthetic', buildDate: sampledAt },
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
  await installSyntheticBackend(page, {
    injectAlignedGap: testInfo.title.includes('explicit missing sample'),
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
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

function moveCommands(pathData: string | null) {
  return pathData?.match(/M/gu)?.length ?? 0;
}

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

test('keeps the live cadence control concise and visually balanced', async ({
  page,
}) => {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const desktop = page.getByTestId('desktop-live-sampling');
  const mobile = page.getByTestId('mobile-live-sampling');
  let samplingButtons = desktop.locator('fieldset button');

  await expect(page.getByText(/NVML.*GPM/u)).toHaveCount(0);
  await expect(
    page.getByText('Physical GPU and MIG topology.', { exact: true }),
  ).toHaveCount(0);
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
    await expect(desktop.locator('button[aria-pressed="true"]')).toHaveCount(1);

    const geometry = await desktop
      .locator('[aria-label="Live status and sampling"]')
      .evaluate((element) => {
        const status = element.querySelector('output')!.getBoundingClientRect();
        const choices = element
          .querySelector('fieldset')!
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

    expect(geometry.width).toBeLessThanOrEqual(184);
    expect(geometry.centerDelta).toBeLessThanOrEqual(1);
    expect(geometry.outerBorderWidth).toBe('0px');
  } else {
    await expect(desktop).toBeHidden();
    await expect(mobile).toBeVisible();
    const trigger = mobile.getByRole('button', {
      name: 'Live status, sampling 1s',
    });
    await expect(trigger).toHaveText('Live · 1s');
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(triggerBox!.width).toBeLessThan(120);

    await trigger.click();
    const popup = page.getByRole('dialog');
    await expect(popup).toBeVisible();
    await expect(popup.locator('button[aria-pressed="true"]')).toHaveCount(1);
    samplingButtons = popup.locator('fieldset button');
  }

  await expect(samplingButtons).toHaveCount(3);
  const buttonBoxes = await samplingButtons.evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width };
    }),
  );
  for (const box of buttonBoxes) expect(box.width).toBeGreaterThanOrEqual(40);
  for (let index = 1; index < buttonBoxes.length; index += 1) {
    expect(
      buttonBoxes[index].left - buttonBoxes[index - 1].right,
    ).toBeGreaterThanOrEqual(3.5);
  }
  if (viewport!.width < 768) {
    const widths = buttonBoxes.map(({ width }) => width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  }

  await expect(page.getByText('Sampling', { exact: true })).toHaveCount(0);
});

test('bounds the process table with sticky headers and a scroll viewport', async ({
  page,
}) => {
  const processSection = page.getByTestId('process-section');
  const viewport = page.getByTestId('process-scroll-viewport');
  const search = page.getByLabel('Filter GPU processes');
  await processSection.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('process-count')).toHaveText(
    `${syntheticProcessCount} CUDA clients`,
  );
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
});

test('switches GPU and People views without reloading charts or clearing process filters', async ({
  page,
}) => {
  await expect.poll(() => alignedRequestCount(page)).toBe(5);
  const filter = page.getByLabel('Filter GPU processes');
  await filter.fill('synthetic-user-17');
  await expect(page.getByTestId('process-count')).toHaveText(
    `1 of ${syntheticProcessCount}`,
  );

  await page.getByRole('button', { name: 'People' }).click();
  await expect(page.getByTestId('people-view')).toBeVisible();
  await expect(
    page.getByText('synthetic-owner', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('synthetic-training', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('second-synthetic-owner', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('synthetic-inference', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open GPU 1 · GI 0 · CI 0 details' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Scheduler assignments describe allocation, not active GPU use.',
      { exact: true },
    ),
  ).toHaveCount(0);

  const personCards = page.getByTestId('person-card');
  await expect(personCards).toHaveCount(2);
  const [firstCard, secondCard] = await Promise.all([
    personCards.nth(0).boundingBox(),
    personCards.nth(1).boundingBox(),
  ]);
  expect(firstCard).not.toBeNull();
  expect(secondCard).not.toBeNull();
  if (page.viewportSize()!.width >= 1280) {
    expect(Math.abs(firstCard!.y - secondCard!.y)).toBeLessThanOrEqual(1);
    expect(secondCard!.x).toBeGreaterThan(firstCard!.x + firstCard!.width);
    expect(Math.abs(firstCard!.width - secondCard!.width)).toBeLessThanOrEqual(
      1,
    );
  } else {
    expect(secondCard!.y).toBeGreaterThanOrEqual(
      firstCard!.y + firstCard!.height + 15,
    );
  }

  await expect(filter).toHaveValue('synthetic-user-17');
  await expect(page.getByTestId('temperature-chart')).toBeVisible();
  await expect.poll(() => alignedRequestCount(page)).toBe(5);

  await page
    .getByRole('button', { name: 'Open GPU 0 · Full GPU details' })
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
  await expect(filter).toHaveValue('synthetic-user-17');
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toBeHidden();

  await page
    .getByRole('button', { name: 'Open GPU 1 · GI 0 · CI 0 details' })
    .click();
  await expect(detail).toBeVisible();
  await expect(
    detail.getByText('synthetic · gpu_instance · available', { exact: true }),
  ).toHaveCount(0);
  await expect(filter).toHaveValue('synthetic-user-17');
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toBeHidden();

  await page.getByRole('button', { name: 'GPUs' }).click();
  await expect(page.getByLabel('GPU topology')).toBeVisible();
  await expect(filter).toHaveValue('synthetic-user-17');
  await expect(page.getByTestId('process-count')).toHaveText(
    `1 of ${syntheticProcessCount}`,
  );
  await expect.poll(() => alignedRequestCount(page)).toBe(5);
});

test('keeps the detail chart 100% tick fully visible', async ({ page }) => {
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();

  const chart = page.getByTestId('detail-history-chart');
  await expect(chart.locator('.recharts-wrapper')).toBeVisible();
  const tick = chart.locator('svg text').filter({ hasText: /^100%$/ });
  await expect(tick).toHaveCount(1);

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
});

test('keeps the Memory tooltip above the process-search stacking context', async ({
  page,
}) => {
  const memoryChart = page.getByTestId('memory-chart');
  await memoryChart.scrollIntoViewIfNeeded();
  const surface = memoryChart.locator('.recharts-surface');
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await page.mouse.move(
    surfaceBox!.x + surfaceBox!.width * 0.65,
    surfaceBox!.y + surfaceBox!.height * 0.5,
  );

  const tooltip = page.getByTestId('memory-chart-tooltip');
  await expect(tooltip).toBeVisible();
  const tooltipWrapper = tooltip.locator(
    'xpath=ancestor::*[contains(@class, "recharts-tooltip-wrapper")]',
  );
  const chartStack = memoryChart.locator('xpath=parent::*');
  const processSearch = page.getByLabel('Filter GPU processes');
  const processStack = page
    .getByTestId('process-section')
    .locator('xpath=parent::*');
  await expect(processSearch).toBeAttached();

  const [tooltipZ, chartZ, processZ] = await Promise.all([
    tooltipWrapper.evaluate((element) => getComputedStyle(element).zIndex),
    chartStack.evaluate((element) => getComputedStyle(element).zIndex),
    processStack.evaluate((element) => getComputedStyle(element).zIndex),
  ]);

  expect(Number(tooltipZ)).toBeGreaterThan(Number(processZ));
  expect(Number(chartZ)).toBeGreaterThan(Number(processZ));

  const tooltipBox = await tooltip.boundingBox();
  expect(tooltipBox).not.toBeNull();
  const overlap = await page.evaluate(
    ({ left, top, width }) => {
      const input = document.querySelector<HTMLInputElement>(
        '[aria-label="Filter GPU processes"]',
      )!;
      const label = input.closest('label')!;
      const tooltip = document.querySelector<HTMLElement>(
        '[data-testid="memory-chart-tooltip"]',
      )!;
      const wrapper = tooltip.closest<HTMLElement>(
        '.recharts-tooltip-wrapper',
      )!;
      const original = {
        label: label.getAttribute('style'),
        pointerEvents: wrapper.style.pointerEvents,
      };

      label.setAttribute(
        'style',
        [
          'position: fixed !important',
          `left: ${left}px !important`,
          `top: ${top}px !important`,
          `width: ${Math.max(120, Math.min(width, 240))}px !important`,
          'z-index: auto !important',
        ].join(';'),
      );
      wrapper.style.setProperty('pointer-events', 'auto', 'important');

      const inputBox = input.getBoundingClientRect();
      const currentTooltipBox = tooltip.getBoundingClientRect();
      const overlapLeft = Math.max(inputBox.left, currentTooltipBox.left);
      const overlapTop = Math.max(inputBox.top, currentTooltipBox.top);
      const overlapRight = Math.min(inputBox.right, currentTooltipBox.right);
      const overlapBottom = Math.min(inputBox.bottom, currentTooltipBox.bottom);
      const x = (overlapLeft + overlapRight) / 2;
      const y = (overlapTop + overlapBottom) / 2;
      const topElement = document.elementFromPoint(x, y);
      const result = {
        hasArea: overlapRight > overlapLeft && overlapBottom > overlapTop,
        tooltipOnTop: topElement != null && tooltip.contains(topElement),
      };

      if (original.label == null) label.removeAttribute('style');
      else label.setAttribute('style', original.label);
      wrapper.style.pointerEvents = original.pointerEvents;
      return result;
    },
    {
      left: tooltipBox!.x,
      top: tooltipBox!.y,
      width: tooltipBox!.width,
    },
  );

  expect(overlap.hasArea).toBe(true);
  expect(overlap.tooltipOnTop).toBe(true);
});
