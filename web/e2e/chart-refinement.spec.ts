import { expect, test, type Page } from '@playwright/test';
import type { GPU, Metric, Snapshot } from '../src/types';
import { systemCapability, systemFixture } from '../src/test/system-fixture';

test.setTimeout(60_000);

const sampledAt = '2026-09-05T16:00:00.000Z';
const metric = (
  value: number,
  unit: string,
  scope: Metric['scope'] = 'physical_gpu',
): Metric => ({
  value,
  unit,
  scope,
  source: 'synthetic',
  sampledAt,
  status: 'available',
});
const gpuMemory = (scope: GPU['memory']['scope'] = 'physical_gpu') => ({
  totalBytes: (scope === 'physical_gpu' ? 80 : 20) * 1024 ** 3,
  usedBytes: (scope === 'physical_gpu' ? 20 : 5) * 1024 ** 3,
  freeBytes: (scope === 'physical_gpu' ? 60 : 15) * 1024 ** 3,
  source: 'synthetic' as const,
  scope,
  sampledAt,
  status: 'available' as const,
});
const gpuMetrics = (scope: Metric['scope'] = 'physical_gpu') => ({
  gpu_activity: metric(55, 'percent', scope),
  sm_activity: metric(42, 'percent', scope),
  memory_activity: metric(30, 'percent', scope),
  dram_activity: metric(30, 'percent', scope),
  temperature: metric(48, 'celsius', scope),
  pcie_rx_bytes_per_second: metric(554.123 * 1024, 'bytes_per_second', scope),
  pcie_tx_bytes_per_second: metric(0, 'bytes_per_second', scope),
});
const gpus: GPU[] = Array.from({ length: 4 }, (_, index) => ({
  uuid: `GPU-chart-${index}`,
  index,
  name: 'Synthetic chart accelerator',
  migEnabled: index !== 2,
  maxMigDevices: index === 2 ? 0 : 4,
  memory: gpuMemory(),
  metrics: gpuMetrics(),
  gpuInstances:
    index === 2
      ? []
      : Array.from({ length: 4 }, (_, ordinal) => ({
          uuid: `GI-chart-${index}-${ordinal}`,
          id: ordinal + 3,
          profile: '1g.20gb',
          generation: `GI-chart-${index}-${ordinal}@1`,
          memory: gpuMemory('gpu_instance'),
          metrics: gpuMetrics('gpu_instance'),
          computeInstances: [
            {
              uuid: `CI-chart-${index}-${ordinal}`,
              id: 0,
              profile: '1c.1g.20gb',
              generation: `CI-chart-${index}-${ordinal}@1`,
              memory: gpuMemory('compute_instance'),
              metrics: {},
            },
          ],
        })),
}));
const provider = {
  name: 'Synthetic chart provider',
  available: true,
  status: 'available' as const,
};
const snapshot: Snapshot = {
  schemaVersion: 'v1',
  sequence: 1,
  sampledAt,
  host: { hostname: 'chart-refinement-host', os: 'linux', arch: 'amd64' },
  system: systemFixture(sampledAt),
  gpus,
  processes: [],
  diagnostics: [],
  capabilities: {
    system: systemCapability,
    nvml: provider,
    gpm: provider,
    dcgm: provider,
    proc: provider,
    profileMetrics: true,
  },
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
    workloads: [],
    assignments: [],
  },
};
const workloadSnapshot: Snapshot = {
  ...snapshot,
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
        ref: 'chart-workspace',
        platform: 'coder',
        kind: 'workspace',
        name: 'chart-training',
        ownerName: 'chart-owner',
      },
    ],
    assignments: gpus.flatMap<
      NonNullable<Snapshot['attribution']>['assignments'][number]
    >((gpu) =>
      gpu.migEnabled
        ? gpu.gpuInstances.flatMap((gi) =>
            gi.computeInstances.map((ci) => ({
              workloadRef: 'chart-workspace',
              entityType: 'compute_instance' as const,
              entityUuid: ci.uuid,
              state: 'allocated' as const,
            })),
          )
        : [
            {
              workloadRef: 'chart-workspace',
              entityType: 'physical_gpu' as const,
              entityUuid: gpu.uuid,
              state: 'allocated' as const,
            },
          ],
    ),
  },
};
const settings = {
  samplingIntervalMs: 500,
  profileIntervalMs: 2_000,
  processIntervalMs: 2_000,
  historyWindowMs: 43_200_000,
  allowedSamplingIntervalsMs: [500, 1_000, 2_000],
};
const history = [80_000, 70_000, 55_000, 40_000, 30_000, 20_000, 10_000, 0].map(
  (before, index) => ({
    sampledAt: new Date(Date.parse(sampledAt) - before).toISOString(),
    values: {
      cpu_utilization: 12.34 + index,
      memory_utilization: 40 + index,
      storage_used_bytes: 420 * 1024 ** 3,
      storage_total_bytes: 1024 ** 4,
      disk_read_bytes_per_second: 554.123 * 1024,
      disk_write_bytes_per_second: 0,
      gpu_activity: 40 + index,
      sm_activity: 30 + index,
      memory_activity: 20 + index,
      dram_activity: 20 + index,
      temperature: 45 + index,
      memory_used_bytes: 20 * 1024 ** 3,
      memory_total_bytes: 80 * 1024 ** 3,
      pcie_rx_bytes_per_second: 554.123 * 1024,
      pcie_tx_bytes_per_second: 0,
    } satisfies Record<string, number>,
  }),
);

function legendCellGeometry(elements: Element[]) {
  return elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    const swatch = element.querySelector('svg')!.getBoundingClientRect();
    const label = element.querySelector<HTMLElement>('[data-legend-label]')!;
    const value = element.querySelector<HTMLElement>('[data-legend-value]')!;
    const labelBounds = label.getBoundingClientRect();
    const valueBounds = value.getBoundingClientRect();
    const centers = [swatch, labelBounds, valueBounds].map(
      (rect) => rect.top + rect.height / 2,
    );
    return {
      label: label.textContent,
      width: bounds.width,
      height: bounds.height,
      labelWidth: label.clientWidth,
      labelScrollWidth: label.scrollWidth,
      valueWidth: value.clientWidth,
      valueScrollWidth: value.scrollWidth,
      centerOffset: Math.max(...centers) - Math.min(...centers),
      radius: getComputedStyle(element).borderRadius,
      aligned: Math.max(...centers) - Math.min(...centers) <= 1,
      noOverlap:
        swatch.right <= labelBounds.left + 1 &&
        labelBounds.right <= valueBounds.left + 1,
      labelFits:
        label.scrollWidth <= label.clientWidth + 1 &&
        label.scrollHeight <= label.clientHeight + 1 &&
        labelBounds.top >= bounds.top - 1 &&
        labelBounds.bottom <= bounds.bottom + 1,
      valueFits:
        value.scrollWidth <= value.clientWidth + 1 &&
        valueBounds.right <= bounds.right + 1 &&
        valueBounds.top >= bounds.top - 1 &&
        valueBounds.bottom <= bounds.bottom + 1,
    };
  });
}

async function installBackend(page: Page, theme: string) {
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem('leviathan.theme.v1', selectedTheme);
    class StableEventSource extends EventTarget {
      readonly readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor() {
        super();
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: StableEventSource,
    });
  }, theme);
  await page.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/snapshot')
      return route.fulfill({ json: snapshot });
    if (pathname === '/api/v1/settings')
      return route.fulfill({ json: settings });
    if (pathname === '/api/v1/version')
      return route.fulfill({
        json: {
          version: 'chart-refinement-fixture',
          commit: 'synthetic',
          buildDate: sampledAt,
        },
      });
    if (pathname === '/api/v1/history/aligned') {
      const request = route.request().postDataJSON() as {
        window: string;
        maxPoints: number;
        series: Array<{ key: string; entity: string; metrics: string[] }>;
      };
      return route.fulfill({
        json: {
          window: request.window,
          series: request.series,
          points: history.slice(0, request.maxPoints).map((point) => ({
            sampledAt: point.sampledAt,
            values: Object.fromEntries(
              request.series.map((series) => [
                series.key,
                Object.fromEntries(
                  series.metrics.flatMap((key) => {
                    const value =
                      point.values[key as keyof typeof point.values];
                    return typeof value === 'number' ? [[key, value]] : [];
                  }),
                ),
              ]),
            ),
          })),
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

async function openWorkloadCharts(page: Page) {
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: workloadSnapshot }),
  );
  await page.goto('/?fixture=workload-charts#workloads');
  await expect(page.locator('.workload-telemetry-panel')).toHaveCount(7);
  await expect(
    page.locator('[data-workload-metric="pcieTotal"] .recharts-wrapper'),
  ).toBeVisible();
  await expect(
    page.locator('.workload-telemetry-panel figure[aria-busy="true"]'),
  ).toHaveCount(0);
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installBackend(
    page,
    testInfo.project.name.endsWith('light') ? 'light' : 'dark',
  );
  await page.goto('/#overview');
  await expect(
    page.getByTestId('host-cpu-chart').locator('.recharts-wrapper'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId('pcie-throughput-chart').locator('.recharts-wrapper'),
  ).toBeVisible({ timeout: 20_000 });
});

test('dense thirteen-series legend strips have equal readable cells and accessible precision', async ({
  page,
}) => {
  const chart = page.getByTestId('pcie-throughput-chart');
  const cells = chart.locator('.compact-chart-legend > button');
  await expect(cells).toHaveCount(13);
  await expect(cells.first()).toHaveAccessibleName(
    'Focus GPU 0 · GI 3. Current 554.1 KiB/s',
  );
  await expect(cells.first().locator('[data-legend-value]')).toHaveText(
    '554 KiB/s',
  );
  const geometry = await cells.evaluateAll(legendCellGeometry);
  expect(
    Math.max(...geometry.map(({ width }) => width)) -
      Math.min(...geometry.map(({ width }) => width)),
  ).toBeLessThanOrEqual(1);
  expect(
    geometry.every(
      ({ height, radius, aligned, noOverlap, labelFits, valueFits }) =>
        height >= 44 &&
        radius === '6px' &&
        aligned &&
        noOverlap &&
        labelFits &&
        valueFits,
    ),
  ).toBe(true);
  await expect(page.getByText('Inspect history', { exact: true })).toHaveCount(
    0,
  );
  const screenshotStyle = await page.addStyleTag({
    content:
      '.mobile-workbench-nav, .leviathan-header, canvas.ambient-snow { visibility: hidden !important; }',
  });
  try {
    await expect(chart.locator('.compact-chart-legend')).toHaveScreenshot(
      'transfer-legend-strip.png',
      { animations: 'disabled' },
    );
    await expect(
      page.getByTestId('host-cpu-chart').locator('.compact-chart-legend'),
    ).toHaveScreenshot('cpu-legend.png', { animations: 'disabled' });
  } finally {
    await screenshotStyle.evaluate((element) =>
      element.parentNode?.removeChild(element),
    );
  }
});

test('every series is reachable in the compact strip without changing panel height', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const chart = page.getByTestId('pcie-throughput-chart');
  const strip = chart.locator('.chart-legend-strip');
  const cells = strip.locator(':scope > button');
  const previous = chart.getByRole('button', {
    name: 'Previous GPU transfers series',
  });
  const next = chart.getByRole('button', {
    name: 'Next GPU transfers series',
  });
  const initialHeight = await chart.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await expect(cells).toHaveCount(13);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  const reachable = new Set<string>();
  for (let step = 0; step < 20; step++) {
    const visible = await strip.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll(':scope > button')].flatMap(
        (button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.left >= viewport.left - 1 &&
            bounds.right <= viewport.right + 1
            ? [button.getAttribute('data-series')!]
            : [];
        },
      );
    });
    visible.forEach((key) => reachable.add(key));
    if (await next.isDisabled()) break;
    const before = await strip.evaluate((element) => element.scrollLeft);
    await next.click();
    await expect
      .poll(() => strip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(before);
  }
  await expect(next).toBeDisabled();
  expect(reachable.size, 'Every series can be fully read using Next').toBe(13);
  await expect(previous).toBeEnabled();
  const heightAfterPaging = await chart.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(Math.abs(heightAfterPaging - initialHeight)).toBeLessThanOrEqual(1);

  await cells.last().focus();
  await page.keyboard.press('Home');
  await expect(cells.first()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(cells.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(cells.last()).toBeFocused();
  await expect
    .poll(() =>
      cells.last().evaluate((element) => {
        const viewport = element
          .closest('.chart-legend-strip')!
          .getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return (
          bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1
        );
      }),
    )
    .toBe(true);
  await page.keyboard.press('ArrowLeft');
  await expect(cells.nth(11)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(cells.first()).toBeFocused();
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test('Overview follows CPU RAM GPU Storage order in responsive compact columns', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One project checks geometry at every breakpoint.',
  );
  const grid = page.locator('.overview-chart-grid');
  const expectedPanels = [
    'host-cpu-chart',
    'host-ram-chart',
    'gpu-activity-chart',
    'utilization-chart',
    'memory-chart',
    'temperature-chart',
    'pcie-throughput-chart',
    'memory-activity-chart',
    'host-storage-chart',
  ];
  await expect(grid.locator(':scope > section')).toHaveCount(
    expectedPanels.length,
  );
  expect(
    await grid
      .locator(':scope > section')
      .evaluateAll((panels) =>
        panels.map((panel) => panel.getAttribute('data-testid')),
      ),
  ).toEqual(expectedPanels);
  expect(
    await page.locator('.host-capacity-label > span').allTextContents(),
  ).toEqual(['CPU', 'RAM', 'GPU', 'Storage']);
  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await grid.evaluate((element) => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      panels: [...element.querySelectorAll(':scope > section')].map((panel) => {
        const bounds = panel.getBoundingClientRect();
        const plot = panel.querySelector('figure')!;
        const plotBounds = plot.getBoundingClientRect();
        const legend = panel.querySelector('.compact-chart-legend')!;
        return {
          id: panel.getAttribute('data-testid'),
          heading: panel.querySelector('.host-chart-heading')?.textContent,
          headingHeight: panel
            .querySelector('.host-chart-heading')
            ?.getBoundingClientRect().height,
          legendHeight: legend.getBoundingClientRect().height,
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
          plotTop: plotBounds.top,
          plotBottom: plotBounds.bottom,
          plotHeight: plotBounds.height,
          plotBeforeLegend: Boolean(
            plot.compareDocumentPosition(legend) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        };
      }),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(layout.columns, `${width}px columns`).toBe(width >= 1024 ? 2 : 1);
    expect(
      layout.panels.every(
        ({ plotHeight }) =>
          Math.abs(plotHeight - (width < 768 ? 144 : 160)) <= 1,
      ),
      `${width}px plot heights`,
    ).toBe(true);
    expect(
      layout.panels.every(({ plotBeforeLegend }) => plotBeforeLegend),
      `${width}px plots precede their legends in document order`,
    ).toBe(true);
    const panelHeights = layout.panels.map(({ height }) => height);
    expect(
      Math.max(...panelHeights) - Math.min(...panelHeights),
      `${width}px all Overview panels have the same height: ${JSON.stringify(layout.panels)}`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...panelHeights),
      `${width}px compact panel height`,
    ).toBeLessThanOrEqual(width < 768 ? 300 : 310);
    for (const panel of layout.panels) {
      const siblings = layout.panels.filter(
        (sibling) => Math.abs(sibling.top - panel.top) <= 1,
      );
      expect(
        siblings.every(
          (sibling) =>
            Math.abs(sibling.plotTop - panel.plotTop) <= 1 &&
            Math.abs(sibling.plotBottom - panel.plotBottom) <= 1 &&
            Math.abs(sibling.bottom - panel.bottom) <= 1,
        ),
        `${width}px ${panel.id} aligns with the other plots and panel bottoms in its row`,
      ).toBe(true);
    }
    expect(layout.overflow, `${width}px page overflow`).toBeLessThanOrEqual(0);
    const legendGeometry = await grid
      .locator('.compact-chart-legend > button')
      .evaluateAll(legendCellGeometry);
    expect(
      legendGeometry.every(
        ({ aligned, noOverlap, labelFits, valueFits }) =>
          aligned && noOverlap && labelFits && valueFits,
      ),
      `${width}px legend alignment and content fit`,
    ).toBe(true);
  }
});

test('direct selection keeps precise values and returns keyboard focus to the live plot', async ({
  page,
}) => {
  const storage = page.getByTestId('host-storage-chart');
  const plot = storage.locator('figure');
  await expect(plot).toHaveAttribute('aria-busy', 'false');
  await plot.focus();
  await page.keyboard.press('Home');
  await expect(
    storage.getByRole('button', { name: 'Read: 554.1 KiB/s' }),
  ).toBeVisible();
  await expect(storage.locator('[data-legend-value]').first()).toHaveText(
    '554 KiB/s',
  );
  const firstTime = await storage
    .locator('.chart-selection-readout time')
    .getAttribute('datetime');
  await page.keyboard.press('End');
  await expect(
    storage.locator('.chart-selection-readout time'),
  ).not.toHaveAttribute('datetime', firstTime!);
  await storage
    .getByRole('button', { name: 'Return Storage to live values' })
    .click();
  await expect(plot).toBeFocused();
  await expect(storage.locator('.chart-selection-readout')).toHaveCount(0);
  await expect(
    storage.getByRole('button', { name: 'Read: 180.0 MiB/s' }),
  ).toBeVisible();
  await expect(plot.locator('[tabindex="0"]')).toHaveCount(0);
});

test('Workloads charts match the compact Overview layout on desktop and phones', async ({
  page,
}, testInfo) => {
  const widths = testInfo.project.name.includes('narrow')
    ? [320, 390]
    : [1440, 1024];
  const overviewHeights = new Map<number, number>();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    overviewHeights.set(
      width,
      await page
        .getByTestId('host-cpu-chart')
        .evaluate((element) => element.getBoundingClientRect().height),
    );
  }
  await openWorkloadCharts(page);
  const grid = page.locator('.workload-telemetry-grid');
  expect(
    await grid.locator('.host-chart-heading h5').allTextContents(),
  ).toEqual([
    'CPU used',
    'RAM used',
    'GPU activity',
    'GPU memory used',
    'GPU memory activity',
    'GPU transfers',
    'Storage I/O',
  ]);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await grid.evaluate((element) => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      panels: [...element.querySelectorAll(':scope > section')].map((panel) => {
        const bounds = panel.getBoundingClientRect();
        const heading = panel.querySelector('.host-chart-heading')!;
        const plot = panel.querySelector('figure')!;
        const legend = panel.querySelector('.compact-chart-legend')!;
        const plotBounds = plot.getBoundingClientRect();
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
          plotTop: plotBounds.top,
          plotBottom: plotBounds.bottom,
          plotHeight: plotBounds.height,
          order:
            Boolean(
              heading.compareDocumentPosition(plot) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            ) &&
            Boolean(
              plot.compareDocumentPosition(legend) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            ),
        };
      }),
      overflow: document.documentElement.scrollWidth - innerWidth,
    }));
    expect(layout.columns, `${width}px workload columns`).toBe(
      width >= 1024 ? 2 : 1,
    );
    expect(layout.overflow, `${width}px page overflow`).toBeLessThanOrEqual(0);
    for (const panel of layout.panels) {
      expect(panel.order, `${width}px heading, plot, legend order`).toBe(true);
      expect(
        Math.abs(panel.plotHeight - (width < 768 ? 144 : 160)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(panel.height - overviewHeights.get(width)!),
      ).toBeLessThanOrEqual(1);
      expect(panel.height).toBeLessThanOrEqual(width < 768 ? 300 : 310);
      const siblings = layout.panels.filter(
        (other) => Math.abs(other.top - panel.top) <= 1,
      );
      expect(
        siblings.every(
          (other) =>
            Math.abs(other.plotTop - panel.plotTop) <= 1 &&
            Math.abs(other.plotBottom - panel.plotBottom) <= 1 &&
            Math.abs(other.bottom - panel.bottom) <= 1,
        ),
      ).toBe(true);
    }
    const geometry = await grid
      .locator('.compact-chart-legend > button')
      .evaluateAll(legendCellGeometry);
    expect(geometry).toHaveLength(56);
    expect(
      geometry.every(
        ({ height, aligned, noOverlap, labelFits, valueFits }) =>
          height >= 44 && aligned && noOverlap && labelFits && valueFits,
      ),
    ).toBe(true);
  }
});

test('Workloads compact legends retain every series and direct history interaction', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWorkloadCharts(page);
  const chart = page.locator('[data-workload-metric="pcieTotal"]');
  const strip = chart.locator('.chart-legend-strip');
  const cells = strip.locator(':scope > button');
  const next = chart.getByRole('button', {
    name: 'Next chart-owner GPU transfers series',
  });
  const initialHeight = await chart.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await expect(cells).toHaveCount(13);
  await next.click();
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await cells.first().focus();
  await page.keyboard.press('Home');
  for (let index = 0; index < 13; index++) {
    const cell = cells.nth(index);
    await expect(cell).toBeFocused();
    await expect
      .poll(() =>
        cell.evaluate((element) => {
          const viewport = element
            .closest('.chart-legend-strip')!
            .getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left >= viewport.left - 1 &&
            bounds.right <= viewport.right + 1
          );
        }),
      )
      .toBe(true);
    if (index < 12) await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Home');
  await expect(cells.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(cells.last()).toBeFocused();
  expect(
    Math.abs(
      (await chart.evaluate(
        (element) => element.getBoundingClientRect().height,
      )) - initialHeight,
    ),
  ).toBeLessThanOrEqual(1);

  const plot = chart.locator('figure');
  await page.keyboard.press('Space');
  await expect(cells.last()).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(0, 0);
  await plot.focus();
  const curves = chart.locator('.recharts-line-curve');
  await expect(curves).toHaveCount(13);
  await expect(curves.first()).toHaveAttribute('stroke-opacity', '0.2');
  await expect(curves.last()).toHaveAttribute('stroke-opacity', '1');
  await cells.last().focus();
  await page.keyboard.press('Space');
  await expect(cells.last()).toHaveAttribute('aria-pressed', 'false');
  await plot.focus();
  await expect(curves.first()).toHaveAttribute('stroke-opacity', '1');
  await page.keyboard.press('Home');
  const time = chart.locator('.chart-selection-readout time');
  await expect(time).toBeVisible();
  const firstTime = await time.getAttribute('datetime');
  await expect(cells.first().locator('[data-legend-value]')).toHaveText(
    '554 KiB/s',
  );
  await page.keyboard.press('End');
  await expect(time).not.toHaveAttribute('datetime', firstTime!);
  await chart
    .getByRole('button', {
      name: 'Return chart-owner GPU transfers to live values',
    })
    .click();
  await expect(plot).toBeFocused();
  await expect(chart.locator('.chart-selection-readout')).toHaveCount(0);
  const historyRequest = page.waitForRequest((request) => {
    if (!request.url().endsWith('/api/v1/history/aligned')) return false;
    const body = request.postDataJSON();
    return body.window === '5m' && body.series[0]?.key.startsWith('assigned_');
  });
  if (page.viewportSize()!.width < 640) {
    await page
      .getByRole('combobox', { name: 'Telemetry window' })
      .selectOption({ label: '5m' });
  } else {
    const fiveMinutes = page
      .getByRole('radiogroup', { name: 'Telemetry window' })
      .getByRole('radio', { name: '5m', exact: true });
    await fiveMinutes.focus();
    await fiveMinutes.press('Space');
    await expect(fiveMinutes).toBeChecked();
  }
  await historyRequest;
  await expect(
    page.locator('.workload-telemetry-panel figure[aria-busy="true"]'),
  ).toHaveCount(0);
  await expect(page.getByText('Inspect history', { exact: true })).toHaveCount(
    0,
  );
});

test('mobile plots allow normal scrolling, direct taps and enlarged text without overflow', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes('narrow'),
    'Touch and enlarged text are checked in both phone themes.',
  );
  const plot = page.getByTestId('host-cpu-chart').locator('figure');
  await plot.scrollIntoViewIfNeeded();
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 1,
  });
  const beforeScroll = await page.evaluate(() => window.scrollY);
  let bounds = (await plot.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 5; step++) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - step * 25 }],
    });
    await page.waitForTimeout(30);
  }
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(beforeScroll + 30);
  await expect(
    page.getByTestId('host-cpu-chart').locator('.chart-selection-readout'),
  ).toHaveCount(0);
  await plot.scrollIntoViewIfNeeded();
  bounds = (await plot.boundingBox())!;
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    ],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(
    page.getByRole('button', { name: 'Return CPU to live values' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Return CPU to live values' }).click();
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  const cells = page
    .getByTestId('pcie-throughput-chart')
    .locator('.compact-chart-legend > button');
  const enlargedGeometry = await cells.evaluateAll(legendCellGeometry);
  expect(
    enlargedGeometry.filter(
      ({ aligned, noOverlap, labelFits, valueFits }) =>
        !aligned || !noOverlap || !labelFits || !valueFits,
    ),
    'Enlarged legend cells must remain aligned without clipping or overlap',
  ).toEqual([]);
});
