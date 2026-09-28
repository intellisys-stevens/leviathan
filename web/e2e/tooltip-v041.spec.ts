import { expect, test, type Page } from '@playwright/test';
import type { GPU, Metric, Snapshot } from '../src/types';
import { systemCapability, systemFixture } from '../src/test/system-fixture';

// Opt in against a production preview: React development profiling adds its
// own allocation/render overhead to dense live charts.
const profileTooltips =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env.LEVIATHAN_PROFILE_TOOLTIPS === '1';

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
const settings = {
  samplingIntervalMs: 500,
  profileIntervalMs: 2_000,
  processIntervalMs: 2_000,
  historyWindowMs: 43_200_000,
  allowedSamplingIntervalsMs: [500, 1_000, 2_000],
};
const history = Array.from({ length: 600 }, (_, index) => ({
  sampledAt: new Date(
    Date.parse(sampledAt) - (599 - index) * 500,
  ).toISOString(),
  values: {
    cpu_utilization: 30 + Math.sin(index / 12) * 20,
    memory_utilization: 40 + Math.sin(index / 20) * 10,
    storage_used_bytes: 420 * 1024 ** 3,
    storage_total_bytes: 1024 ** 4,
    disk_read_bytes_per_second: 554.123 * 1024,
    disk_write_bytes_per_second: 0,
    gpu_activity: 50 + Math.sin(index / 12) * 25,
    sm_activity: 50 + Math.sin(index / 12) * 25,
    memory_activity: 20 + Math.sin(index / 18) * 10,
    dram_activity: 20 + Math.sin(index / 18) * 10,
    temperature: 45 + Math.sin(index / 30) * 5,
    memory_used_bytes: 20 * 1024 ** 3,
    memory_total_bytes: 80 * 1024 ** 3,
    pcie_rx_bytes_per_second: (100 + index) * 1024,
    pcie_tx_bytes_per_second: 0,
  } satisfies Record<string, number>,
}));

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
        Object.assign(window, { __chartEventSource: this });
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

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    page.viewportSize()!.width < 768,
    'Hover tooltips are desktop-only.',
  );
  test.skip(
    testInfo.title.startsWith('dense chart hover') && !profileTooltips,
    'Set LEVIATHAN_PROFILE_TOOLTIPS=1 with a production preview to profile hover latency without React development instrumentation.',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installBackend(
    page,
    testInfo.project.name.endsWith('light') ? 'light' : 'dark',
  );
  await page.addInitScript(() => {
    localStorage.setItem('leviathan.chartWindow.v1', '300000');
  });
  await page.goto('/#overview');
  const chart = page.getByTestId('utilization-chart');
  await chart.scrollIntoViewIfNeeded();
  await expect(chart.locator('figure')).toHaveAttribute('aria-busy', 'false');
  await expect(chart.locator('.recharts-line-curve')).toHaveCount(13);
});

test('dense chart hover stays visible, accurate and inside the viewport during live data', async ({
  page,
}, testInfo) => {
  test.skip(
    page.viewportSize()!.width < 768,
    'Hover tooltips are desktop-only.',
  );
  const chart = page.getByTestId('utilization-chart');
  const plot = chart.locator('.recharts-wrapper');
  const bounds = (await plot
    .locator('.recharts-cartesian-grid')
    .boundingBox())!;
  const tooltip = page.getByTestId('utilization-chart-tooltip');
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(tooltip).toBeVisible();
  await expect(
    tooltip.getByText('GPU 0 · GI 3', { exact: true }),
  ).toBeVisible();

  await page.evaluate((base) => {
    const source = (window as unknown as { __chartEventSource: EventTarget })
      .__chartEventSource;
    let sequence = 0;
    const timer = window.setInterval(() => {
      const next = structuredClone(base);
      sequence++;
      next.sequence += sequence;
      next.sampledAt = new Date(
        Date.parse(base.sampledAt) + sequence * 500,
      ).toISOString();
      for (const gpu of next.gpus) {
        gpu.memory.sampledAt = next.sampledAt;
        for (const value of Object.values(gpu.metrics))
          value.sampledAt = next.sampledAt;
        for (const gi of gpu.gpuInstances) {
          gi.memory.sampledAt = next.sampledAt;
          for (const value of Object.values(gi.metrics))
            value.sampledAt = next.sampledAt;
        }
      }
      source.dispatchEvent(
        new MessageEvent('snapshot', { data: JSON.stringify(next) }),
      );
    }, 500);
    const portalSelector = '[data-testid="utilization-chart-tooltip"]';
    const currentPortal = () =>
      document
        .querySelector(portalSelector)
        ?.closest<HTMLElement>('.chart-tooltip-portal');
    const latencies: number[] = [];
    let pending = 0;
    let tooltipReads = 0;
    let anchorReads = 0;
    let hiddenFrames = 0;
    let frames = 0;
    let done = false;
    const originalRect = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getBoundingClientRect',
    )!.value as Element['getBoundingClientRect'];
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches('.chart-tooltip-portal')) tooltipReads++;
      if (this.matches('[data-testid="utilization-chart"] [data-chart-curve]'))
        anchorReads++;
      return originalRect.call(this);
    };
    const onMove = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="utilization-chart"]')
      )
        pending = performance.now();
    };
    document.addEventListener('mousemove', onMove, true);
    const observer = new MutationObserver((records) => {
      const portal = currentPortal();
      if (!portal) return;
      if (
        !pending ||
        !records.some(
          (record) =>
            portal === record.target ||
            portal.contains(record.target) ||
            [...record.addedNodes].some(
              (node) => node === portal || node.contains(portal),
            ),
        )
      )
        return;
      const start = pending;
      pending = 0;
      requestAnimationFrame(() => latencies.push(performance.now() - start));
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    const inspectFrame = () => {
      if (done) return;
      frames++;
      const portal = currentPortal();
      if (!portal || getComputedStyle(portal).visibility !== 'visible')
        hiddenFrames++;
      requestAnimationFrame(inspectFrame);
    };
    requestAnimationFrame(inspectFrame);
    Object.assign(window, {
      __finishTooltipProfile: () => {
        done = true;
        window.clearInterval(timer);
        observer.disconnect();
        document.removeEventListener('mousemove', onMove, true);
        Element.prototype.getBoundingClientRect = originalRect;
        const sorted = [...latencies].sort((a, b) => a - b);
        return {
          samples: sorted.length,
          p50Ms: sorted[Math.floor(sorted.length * 0.5)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          maximumMs: sorted.at(-1),
          tooltipReads,
          anchorReads,
          hiddenFrames,
          frames,
          browser: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          devicePixelRatio,
        };
      },
    });
  }, snapshot);

  for (let index = 0; index < 120; index++) {
    const phase = (index % 60) / 59;
    const progress = index < 60 ? phase : 1 - phase;
    await page.mouse.move(
      bounds.x + 12 + progress * (bounds.width - 24),
      bounds.y + bounds.height / 2 + Math.sin(index / 5) * 12,
    );
  }
  await expect(tooltip).toBeVisible();
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __finishTooltipProfile: () => Record<string, number | string>;
      }
    ).__finishTooltipProfile(),
  );
  await testInfo.attach('tooltip-profile.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  console.log('TOOLTIP_PROFILE', JSON.stringify(result));
  expect(result.samples).toBeGreaterThan(60);
  expect(result.hiddenFrames).toBe(0);
  expect(result.p95Ms).toBeLessThan(50);
  expect(result.tooltipReads).toBeLessThan(Number(result.samples) / 3);

  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await plot.scrollIntoViewIfNeeded();
    const resized = (await plot
      .locator('.recharts-cartesian-grid')
      .boundingBox())!;
    await page.mouse.move(resized.x + resized.width - 30, resized.y + 25);
    await expect(tooltip).toBeVisible();
    await expect
      .poll(async () => {
        const rect = (await tooltip.boundingBox())!;
        return (
          rect.x >= 7 &&
          rect.y >= 7 &&
          rect.x + rect.width <= width - 7 &&
          rect.y + rect.height <= 893
        );
      })
      .toBe(true);
  }
  const before = (await tooltip.boundingBox())!;
  await page.evaluate(() => window.scrollBy(0, 20));
  await expect
    .poll(async () => Math.abs((await tooltip.boundingBox())!.y - before.y))
    .toBeGreaterThan(5);
});

test('hover values change across samples and keyboard history returns to live', async ({
  page,
}, testInfo) => {
  test.skip(
    page.viewportSize()!.width < 768,
    'Hover tooltips are desktop-only.',
  );
  const chart = page.getByTestId('utilization-chart');
  const plot = chart.locator('.recharts-wrapper');
  const bounds = (await plot
    .locator('.recharts-cartesian-grid')
    .boundingBox())!;
  const tooltip = page.getByTestId('utilization-chart-tooltip');
  await page.mouse.move(
    bounds.x + bounds.width * 0.4,
    bounds.y + bounds.height / 2,
  );
  await expect(tooltip).toBeVisible();
  const observed = await tooltip.evaluate((element) => ({
    time: Date.parse(element.querySelector('p')!.textContent!),
    value:
      element.lastElementChild!.firstElementChild!.lastElementChild!
        .textContent!,
  }));
  // The existing five-minute chart labels the end of each one-second mean.
  // Verify that exact plotted value, rather than comparing it to a raw sample.
  const bucket = history.filter((point) => {
    const time = Date.parse(point.sampledAt);
    return time >= observed.time - 1000 && time < observed.time;
  });
  const mean =
    bucket.reduce((sum, point) => sum + point.values.sm_activity, 0) /
    bucket.length;
  expect(observed.value).toBe(`${mean.toFixed(1)}%`);
  await page.screenshot({ path: testInfo.outputPath('tooltip.png') });
  const first = await tooltip.textContent();
  await page.mouse.move(
    bounds.x + bounds.width * 0.7,
    bounds.y + bounds.height / 2,
  );
  await expect(tooltip).not.toHaveText(first!);
  await page.mouse.move(0, 0);
  const figure = chart.locator('figure');
  await figure.focus();
  await page.keyboard.press('Home');
  await expect(chart.locator('.chart-selection-readout time')).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  await chart.getByRole('button', { name: /Return .* to live values/ }).click();
  await expect(figure).toBeFocused();
  await expect(chart.locator('.chart-selection-readout')).toHaveCount(0);
});
