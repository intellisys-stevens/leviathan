/// <reference types="node" />

import AxeBuilder from '@axe-core/playwright';
import { platform } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import type { components } from '../src/api.gen';
import type { AlignedHistoryRequest, Snapshot } from '../src/types';
import { ownerFixture } from '../src/test/owner-fixture';
import { systemCapability, systemFixture } from '../src/test/system-fixture';

test.setTimeout(60_000);

const sampledAt = '2026-09-05T16:00:00.000Z';
const ownerSampledAt = '2026-09-05T15:59:58.000Z';
const ownerA = `owner_${'a'.repeat(32)}`;
const ownerB = `owner_${'b'.repeat(32)}`;
const ownerMetricKeys = [
  'cpu_cores',
  'memory_used_bytes',
  'storage_read_bps',
  'storage_write_bps',
];
type Status = components['schemas']['HealthStatus'];
type Counts = components['schemas']['HealthCounts'];
type FixtureWindow = Window & {
  __ownerFixture: {
    publish: (snapshot: Snapshot) => void;
    disconnect: () => void;
  };
};

function cpuOnlySnapshot(): Snapshot {
  const first = ownerFixture(ownerA, 'Aster', ownerSampledAt);
  const second = ownerFixture(ownerB, 'Birch', ownerSampledAt);
  second.metrics.cpu_cores.value = 3.25;
  second.metrics.memory_used_bytes.value = 8 * 2 ** 30;
  first.workspaces[0].name = 'Analysis and preprocessing workspace';
  const unavailable = {
    name: 'GPU driver',
    available: false,
    status: 'unsupported' as const,
  };
  return {
    schemaVersion: 'v1',
    sequence: 1,
    sampledAt,
    host: { hostname: 'owner-resource-fixture', os: 'linux', arch: 'amd64' },
    system: {
      ...systemFixture(sampledAt),
      uptime: {
        value: 97_200,
        unit: 'seconds',
        source: 'procfs',
        scope: 'host',
        sampledAt,
        status: 'available',
      },
    },
    gpus: [],
    processes: [],
    diagnostics: [],
    capabilities: {
      system: systemCapability,
      nvml: unavailable,
      gpm: unavailable,
      dcgm: unavailable,
      proc: unavailable,
      profileMetrics: false,
    },
    workloadTelemetry: {
      sampledAt: ownerSampledAt,
      observedAt: ownerSampledAt,
      status: 'available',
      owners: [first, second],
    },
  };
}

const counts = (values: Partial<Counts> = {}): Counts => ({
  operational: 0,
  degraded: 0,
  unavailable: 0,
  unsupported: 0,
  unknown: 0,
  ...values,
});

function statusFixture(): Status {
  return {
    sampledAt,
    monitorStartedAt: '2026-09-05T14:00:00.000Z',
    monitorUptimeSeconds: 7200,
    retentionDays: 90,
    persistence: { enabled: true, saving: true },
    components: [
      {
        id: 'uplink',
        label: 'Yggdrasil connection',
        state: 'operational',
        observedAt: sampledAt,
        lastAcknowledgedAt: sampledAt,
      },
      {
        id: 'system',
        label: 'Host telemetry',
        state: 'operational',
        observedAt: sampledAt,
      },
      { id: 'gpu', label: 'GPU telemetry', state: 'unsupported' },
      {
        id: 'attribution',
        label: 'Workspace attribution',
        state: 'unavailable',
      },
    ],
    days: Array.from({ length: 90 }, (_, index) => {
      const date = new Date(
        Date.parse('2026-06-08T00:00:00Z') + index * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      const expectedSamples = index === 89 ? 960 : 1440;
      let system = counts({ operational: expectedSamples });
      if (index === 0) system = counts({ operational: 720, unknown: 720 });
      if (index === 1) system = counts({ operational: 720, degraded: 720 });
      if (index === 2) system = counts({ unsupported: 1440 });
      if (index === 3) system = counts({ operational: 1439, unavailable: 1 });
      return {
        date,
        expectedSamples,
        components: {
          system,
          gpu: counts({ unsupported: expectedSamples }),
          uplink:
            index === 0
              ? counts({ unknown: expectedSamples })
              : counts({ operational: expectedSamples }),
          attribution: counts({ unavailable: expectedSamples }),
        },
      };
    }),
  };
}

const settings = {
  samplingIntervalMs: 2_000,
  profileIntervalMs: 2_000,
  processIntervalMs: 2_000,
  historyWindowMs: 43_200_000,
  allowedSamplingIntervalsMs: [500, 1_000, 2_000],
};

async function installBackend(page: Page, theme: 'dark' | 'light') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: AlignedHistoryRequest[] = [];
  const initialSnapshot = cpuOnlySnapshot();
  await page.addInitScript(
    ({ snapshot, selectedTheme }) => {
      localStorage.setItem('leviathan.theme.v1', selectedTheme);
      localStorage.setItem('leviathan.chartWindow.v1', '300000');
      (
        window as unknown as { __LEVIATHAN_TEST_SNOW_SEED__: number }
      ).__LEVIATHAN_TEST_SNOW_SEED__ = 481516;
      let current = snapshot;
      let sequence = snapshot.sequence;
      let paused = false;
      const sources = new Set<StableEventSource>();
      class StableEventSource extends EventTarget {
        readonly readyState = 1;
        onopen: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        private timer: number;
        private closed = false;
        constructor() {
          super();
          sources.add(this);
          this.timer = window.setInterval(() => this.emit(), 1_000);
          queueMicrotask(() => {
            this.onopen?.(new Event('open'));
            this.emit();
          });
        }
        emit() {
          if (paused || this.closed) return;
          this.dispatchEvent(
            new MessageEvent('snapshot', {
              data: JSON.stringify({ ...current, sequence: ++sequence }),
            }),
          );
        }
        close() {
          this.closed = true;
          window.clearInterval(this.timer);
          sources.delete(this);
        }
      }
      Object.defineProperty(window, 'EventSource', {
        configurable: true,
        value: StableEventSource,
      });
      (window as unknown as FixtureWindow).__ownerFixture = {
        publish(next) {
          current = next;
          paused = false;
          for (const source of sources) source.emit();
        },
        disconnect() {
          paused = true;
          for (const source of sources) source.onerror?.(new Event('error'));
        },
      };
    },
    { snapshot: initialSnapshot, selectedTheme: theme },
  );
  await page.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/snapshot')
      return route.fulfill({ json: initialSnapshot });
    if (pathname === '/api/v1/settings')
      return route.fulfill({ json: settings });
    if (pathname === '/api/v1/status')
      return route.fulfill({ json: statusFixture() });
    if (pathname === '/api/v1/version')
      return route.fulfill({
        json: {
          version: 'status-owner-fixture',
          commit: 'synthetic',
          buildDate: sampledAt,
        },
      });
    if (pathname === '/api/v1/history/aligned') {
      const request = route.request().postDataJSON() as AlignedHistoryRequest;
      requests.push(request);
      const milliseconds =
        request.window === '15m'
          ? 900_000
          : request.window === '30m'
            ? 1_800_000
            : 300_000;
      const length = Math.min(request.maxPoints, milliseconds / 2_000 + 1);
      return route.fulfill({
        json: {
          window: request.window,
          series: request.series,
          points: Array.from({ length }, (_, index) => {
            const timestamp =
              Date.parse(ownerSampledAt) -
              milliseconds +
              (index * milliseconds) / (length - 1) +
              (index > 0 && index < length - 1 && index % 2 ? 250 : 0);
            return {
              sampledAt: new Date(timestamp).toISOString(),
              values: Object.fromEntries(
                request.series.map((series) => {
                  const second = series.entity === `owner:${ownerB}`;
                  const measured: Record<string, number> = {
                    cpu_cores: (second ? 3 : 1.5) + 0.75 * Math.sin(index / 9),
                    memory_used_bytes:
                      (second ? 8 : 1 + 0.2 * Math.sin(index / 25)) * 2 ** 30,
                    storage_read_bps: 350_000 + 300_000 * Math.sin(index / 12),
                    storage_write_bps: 200_000 + 100_000 * Math.cos(index / 10),
                  };
                  return [
                    series.key,
                    index === Math.floor(length / 2)
                      ? {}
                      : Object.fromEntries(
                          series.metrics.flatMap((metric) =>
                            measured[metric] == null
                              ? []
                              : [[metric, measured[metric]]],
                          ),
                        ),
                  ];
                }),
              ),
            };
          }),
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
  return requests;
}

async function openOwners(page: Page) {
  await page.goto('/?fixture=status-workloads#workloads');
  await expect(
    page.getByRole('heading', { name: 'Aster', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-owner-metric]')).toHaveCount(3);
  await expect(
    page.locator('[data-owner-metric] figure[aria-busy="true"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-owner-metric="cpu"] .recharts-wrapper'),
  ).toBeVisible();
  await expect(
    page.locator('[data-owner-metric="cpu"] [data-legend-value]'),
  ).toHaveText('1.5 cores');
  await page.evaluate(() => document.fonts.ready);
}

async function openStatus(page: Page, hash = 'status') {
  await page.goto(`/?fixture=status-workloads#${hash}`);
  await expect(
    page.getByRole('heading', { name: '90-day history' }),
  ).toBeVisible();
  await expect(page.locator('.health-status .health-component')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
}

async function selectOwner(page: Page, name: string) {
  const select = page.getByRole('combobox', {
    name: 'Select user',
    exact: true,
  });
  if (await select.isVisible()) await select.selectOption({ label: name });
  else await page.getByRole('tab', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function assertNoOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    })),
  ).toEqual(expect.objectContaining({ viewport: page.viewportSize()!.width }));
  const overflow = await page.evaluate(
    () =>
      Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ) - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

function themeFor(name: string): 'light' | 'dark' {
  return name.endsWith('light') ? 'light' : 'dark';
}

test('CPU-only owners have one shared range, independent timestamps and one history request per owner/window', async ({
  page,
}, testInfo) => {
  const requests = await installBackend(page, themeFor(testInfo.project.name));
  await openOwners(page);
  await expect(page.locator('[data-workload-metric]')).toHaveCount(0);
  await expect(page.getByText('Inspect history', { exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.locator('[data-owner-metric] h5').allTextContents(),
  ).toEqual(['CPU used', 'RAM used', 'Storage I/O']);
  await expect(
    page.locator('[aria-label="Telemetry window"]:visible'),
  ).toHaveCount(1);
  await expect
    .poll(
      () =>
        requests.filter(({ series }) =>
          series.some(({ entity }) => entity === `owner:${ownerA}`),
        ).length,
    )
    .toBe(1);
  expect(requests[0].series).toEqual([
    { key: 'owner', entity: `owner:${ownerA}`, metrics: ownerMetricKeys },
  ]);

  const cpu = page.locator('[data-owner-metric="cpu"]');
  const plot = cpu.locator('figure');
  await plot.focus();
  await plot.press('End');
  // Five-minute trends use one-second bucket ends. The owner observation is
  // two seconds earlier than the host snapshot and must anchor its own range.
  await expect(cpu.locator('.chart-selection-readout time')).toHaveAttribute(
    'datetime',
    '2026-09-05T15:59:59.000Z',
  );
  await plot.press('Home');
  await expect(cpu.locator('.chart-selection-readout time')).toHaveAttribute(
    'datetime',
    '2026-09-05T15:54:59.000Z',
  );
  await plot.press('Escape');
  await expect(cpu.locator('.chart-selection-readout')).toHaveCount(0);
  await expect(cpu.locator('[data-legend-value]')).toHaveText('1.5 cores');

  const rangeSelect = page.getByRole('combobox', { name: 'Telemetry window' });
  if (await rangeSelect.isVisible()) await rangeSelect.selectOption('900000');
  else {
    const fifteenMinutes = page
      .getByRole('radiogroup', { name: 'Telemetry window' })
      .getByRole('radio', { name: '15m', exact: true });
    await fifteenMinutes.focus();
    await fifteenMinutes.press('Space');
    await expect(fifteenMinutes).toBeChecked();
  }
  await expect
    .poll(() => requests.filter(({ window }) => window === '15m').length)
    .toBe(1);
  const snow = await page
    .locator('[data-testid="person-card"] [data-slot="snow-cap-body"]')
    .innerHTML();
  await selectOwner(page, 'Birch');
  await expect(
    page.locator('[data-owner-metric="cpu"] [data-legend-value]'),
  ).toHaveText('3.25 cores');
  await expect(
    page.locator('[data-owner-metric="ram"] [data-legend-value]'),
  ).toHaveText('8 GiB');
  await expect
    .poll(
      () =>
        requests.filter(({ series }) =>
          series.some(({ entity }) => entity === `owner:${ownerB}`),
        ).length,
    )
    .toBe(1);
  expect(
    await page
      .locator('[data-testid="person-card"] [data-slot="snow-cap-body"]')
      .innerHTML(),
  ).toBe(snow);
  expect(
    requests.every(
      ({ series }) =>
        series.length === 1 && series[0].entity.startsWith('owner:'),
    ),
  ).toBe(true);
});

test('measured zero, partial, unavailable and disconnected owner values remain distinct', async ({
  page,
}, testInfo) => {
  await installBackend(page, themeFor(testInfo.project.name));
  await openOwners(page);
  const next = cpuOnlySnapshot();
  const owner = next.workloadTelemetry!.owners[0];
  owner.sampledAt = sampledAt;
  owner.status = 'partial';
  next.workloadTelemetry!.status = 'partial';
  owner.metrics.cpu_cores = { ...owner.metrics.cpu_cores, value: 0, sampledAt };
  owner.metrics.memory_used_bytes = {
    ...owner.metrics.memory_used_bytes,
    value: null,
    status: 'error',
    message: 'Partial: one of two Pod readings is unavailable',
    sampledAt,
  };
  for (const key of ['storage_read_bps', 'storage_write_bps'])
    owner.metrics[key] = {
      ...owner.metrics[key],
      value: null,
      status: 'unsupported',
      sampledAt,
    };
  await page.evaluate(
    (snapshot) =>
      (window as unknown as FixtureWindow).__ownerFixture.publish(snapshot),
    next,
  );
  await expect(
    page.locator('[data-owner-metric="cpu"] [data-legend-value]'),
  ).toHaveText('0 cores');
  await expect(
    page.locator('[data-owner-metric="ram"] .host-chart-state'),
  ).toHaveText('Partial');
  await expect(
    page.locator('[data-owner-metric="ram"] [data-legend-value]'),
  ).toHaveText('—');
  await expect(
    page.locator('[data-owner-metric="io"] .host-chart-state'),
  ).toHaveText('No data');
  await expect(
    page.locator('[data-owner-metric="io"] [data-legend-value]'),
  ).toHaveText(['—', '—']);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).__ownerFixture.disconnect(),
  );
  await expect(
    page.locator('[data-owner-metric] .host-chart-state'),
  ).toHaveText(['Paused', 'Paused', 'Paused']);
  await expect(
    page.locator('[data-owner-metric] [data-legend-value]'),
  ).toHaveText(['—', '—', '—', '—']);
  await expect(
    page.locator('[data-owner-metric="cpu"] .recharts-line-curve'),
  ).toBeAttached();
});

test('phone Storage I/O legends keep complete units in one row while both series remain reachable', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await installBackend(page, themeFor(testInfo.project.name));
  await openOwners(page);
  const panel = page.locator('[data-owner-metric="io"]');
  const strip = panel.locator('.chart-legend-strip');
  const cells = strip.locator(':scope > button');
  await expect(cells).toHaveCount(2);
  const initialHeight = (await panel.boundingBox())!.height;
  const measurements = await cells.evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      const value = button.querySelector<HTMLElement>('[data-legend-value]')!;
      const valueBounds = value.getBoundingClientRect();
      const style = getComputedStyle(value);
      return {
        top: bounds.top,
        height: bounds.height,
        valueHeight: valueBounds.height,
        lineHeight: Number.parseFloat(style.lineHeight),
        fits:
          valueBounds.right <= bounds.right &&
          value.scrollWidth <= value.clientWidth,
      };
    }),
  );
  expect(measurements[0].top).toBe(measurements[1].top);
  for (const measurement of measurements) {
    expect(measurement.height).toBe(44);
    expect(measurement.valueHeight).toBeCloseTo(measurement.lineHeight, 1);
    expect(measurement.fits).toBe(true);
  }
  await expect(cells.last().locator('[data-legend-value]')).toHaveText(
    '1 KiB/s',
  );
  await panel
    .getByRole('button', { name: 'Next Aster Storage I/O series', exact: true })
    .click();
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  const visible = await cells.last().evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const viewport = button.parentElement!.getBoundingClientRect();
    return (
      bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1
    );
  });
  expect(visible).toBe(true);
  await cells.first().focus();
  await cells.first().press('Home');
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBe(0);
  await cells.first().press('ArrowRight');
  await expect(cells.last()).toBeFocused();
  expect((await panel.boundingBox())!.height).toBe(initialHeight);
});

test('Status has three compact timelines with direct keyboard inspection and visible observation gaps', async ({
  page,
}, testInfo) => {
  await installBackend(page, themeFor(testInfo.project.name));
  await openStatus(page, 'diagnostics');
  await expect(page).toHaveURL(/#status$/u);
  expect(await page.locator('.health-component h4').allTextContents()).toEqual([
    'Yggdrasil connection',
    'Host telemetry',
    'GPU telemetry',
  ]);
  await expect(page.locator('.health-current .health-state')).toHaveText(
    'Operational',
  );
  await expect(
    page
      .locator('.health-status')
      .getByText('Workspace attribution', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('.health-status').getByText('Unsupported', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Inspect day')).toHaveCount(0);
  await expect(
    page.locator('.health-status').getByRole('combobox'),
  ).toHaveCount(0);
  await expect(page.locator('.health-status').getByRole('slider')).toHaveCount(
    3,
  );
  const host = page.locator('.health-component').filter({
    has: page.getByRole('heading', { name: 'Host telemetry', exact: true }),
  });
  const timeline = host.getByRole('slider');
  await timeline.focus();
  await timeline.press('Home');
  await expect(timeline).toHaveAttribute(
    'aria-valuetext',
    '2026-06-08: Operational; 50% coverage',
  );
  expect(
    await host
      .locator('.health-day')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundImage),
  ).toContain('repeating-linear-gradient');
  await timeline.press('ArrowRight');
  await expect(timeline).toHaveAttribute(
    'aria-valuetext',
    '2026-06-09: Degraded; 100% coverage',
  );
  await timeline.press('ArrowRight');
  await expect(timeline).toHaveAttribute(
    'aria-valuetext',
    '2026-06-10: No data; 0% coverage',
  );
  await timeline.press('ArrowRight');
  await expect(timeline).toHaveAttribute(
    'aria-valuetext',
    '2026-06-11: Unavailable; 100% coverage',
  );
  await expect(timeline).toHaveAttribute('max', '90');
  await timeline.press('Home');
  await timeline.press('ArrowDown');
  await expect(timeline).toHaveValue(
    page.viewportSize()!.width >= 1024 ? '90' : '31',
  );
  await timeline.press('ArrowUp');
  await expect(timeline).toHaveValue('1');
  await timeline.press('End');
  await expect(timeline).toHaveAttribute(
    'aria-valuetext',
    '2026-09-05: Operational; 100% coverage',
  );
  await timeline.press('Escape');
  await expect(host.locator('.health-day-tooltip')).toHaveCount(0);
  const dimensions = await host.locator('.health-day').evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        left: bounds.left,
        top: bounds.top,
      };
    }),
  );
  expect(dimensions).toHaveLength(90);
  for (const [index, value] of dimensions.entries()) {
    expect(value.width).toBe(5);
    expect(value.height).toBe(24);
    if (index) {
      const previous = dimensions[index - 1];
      if (value.top === previous.top)
        expect(value.left - previous.left).toBeCloseTo(8, 1);
      else {
        expect(value.top - previous.top).toBe(44);
        expect(value.left).toBe(dimensions[0].left);
      }
    }
  }
  expect(
    (await host.locator('.health-timeline').boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  await openStatus(page, 'operations');
  await expect(page).toHaveURL(/#status$/u);
});

for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1440]) {
  test(`owner charts and Status fit ${width}px without clipped labels or horizontal scrolling`, async ({
    page,
  }, testInfo) => {
    test.skip(
      (testInfo.project.use.viewport?.width ?? 1280) < 1024,
      'The themed desktop projects own the full width matrix.',
    );
    await page.setViewportSize({ width, height: 900 });
    await installBackend(page, themeFor(testInfo.project.name));
    await openOwners(page);
    await assertNoOverflow(page);
    const panels = await page
      .locator('[data-owner-metric]')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, top: bounds.top, width: bounds.width };
        }),
      );
    if (width >= 1024) {
      expect(panels[0].top).toBeCloseTo(panels[1].top, 1);
      expect(panels[2].width).toBeGreaterThan(panels[0].width * 1.9);
    } else {
      expect(panels[0].top).toBeLessThan(panels[1].top);
      expect(panels[1].top).toBeLessThan(panels[2].top);
    }
    const legendBounds = await page
      .locator('[data-owner-metric] .compact-chart-legend > button')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const bounds = button.getBoundingClientRect();
          const label = button
            .querySelector('[data-legend-label]')!
            .getBoundingClientRect();
          const value = button
            .querySelector('[data-legend-value]')!
            .getBoundingClientRect();
          return {
            height: bounds.height,
            noOverlap: label.right <= value.left + 1,
            fits: value.right <= bounds.right + 1,
          };
        }),
      );
    expect(
      legendBounds.every(
        ({ height, noOverlap, fits }) => height >= 44 && noOverlap && fits,
      ),
    ).toBe(true);
    await openStatus(page);
    await assertNoOverflow(page);
    for (const timeline of await page.locator('.health-timeline').all()) {
      const bounds = (await timeline.boundingBox())!;
      if (width >= 1024) {
        expect(bounds.width).toBe(717);
        expect(bounds.height).toBe(44);
      } else {
        expect(bounds.width).toBe(237);
        expect(bounds.height).toBe(132);
      }
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
  });
}

test('new views remain accessible after lazy charts load, with enlarged text and forced colors', async ({
  page,
}, testInfo) => {
  await installBackend(page, themeFor(testInfo.project.name));
  await page.setViewportSize({ width: 360, height: 800 });
  await openOwners(page);
  await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
  await assertNoOverflow(page);
  expect(
    (
      await new AxeBuilder({ page })
        .include('[data-testid="people-view"]')
        .analyze()
    ).violations,
  ).toEqual([]);
  await openStatus(page);
  await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
  await assertNoOverflow(page);
  expect(
    (await new AxeBuilder({ page }).include('.health-status').analyze())
      .violations,
  ).toEqual([]);
  await page.emulateMedia({ forcedColors: 'active' });
  const slider = page.getByRole('slider', {
    name: 'Host telemetry daily history',
  });
  await slider.focus();
  await slider.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', /50% coverage/u);
  const outline = await page
    .locator('.health-timeline:focus-within')
    .evaluate((element) => ({
      style: getComputedStyle(element).outlineStyle,
      width: getComputedStyle(element).outlineWidth,
    }));
  expect(outline.style).not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
});

test('new owner and Status panels have reviewed Linux visual baselines', async ({
  page,
}, testInfo) => {
  test.skip(platform() !== 'linux', 'Visual baselines are reviewed on Linux.');
  await installBackend(page, themeFor(testInfo.project.name));
  await openOwners(page);
  await page.addStyleTag({
    content:
      '.workbench-nav, .leviathan-header, canvas.ambient-snow { visibility: hidden !important; }',
  });
  await expect(page.getByTestId('person-card')).toHaveScreenshot(
    'owner-host-resources.png',
    { animations: 'disabled' },
  );
  await openStatus(page);
  await page.addStyleTag({
    content:
      '.workbench-nav, .leviathan-header, canvas.ambient-snow { visibility: hidden !important; }',
  });
  await expect(page.locator('.health-status')).toHaveScreenshot(
    'status-observation-timelines.png',
    { animations: 'disabled' },
  );
});

test.describe('phone direct inspection', () => {
  test.use({
    viewport: { width: 360, height: 640 },
    hasTouch: true,
    isMobile: true,
  });
  test('taps inspect a day while vertical touch scrolling preserves the selection', async ({
    page,
  }, testInfo) => {
    await installBackend(page, themeFor(testInfo.project.name));
    await openStatus(page);
    const timeline = page.locator('.health-timeline').first();
    // Keep all three tap rows clear of the fixed phone navigation.
    await timeline.evaluate((element) =>
      element.scrollIntoView({ block: 'center' }),
    );
    const bounds = (await timeline.boundingBox())!;
    await page.touchscreen.tap(bounds.x + 3, bounds.y + 22);
    const control = page.getByRole('slider', {
      name: 'Yggdrasil connection daily history',
    });
    await expect(control).toHaveValue('1');
    await expect(control).toHaveAttribute(
      'aria-valuetext',
      '2026-06-08: No data; 0% coverage',
    );
    await page.touchscreen.tap(bounds.x + 3, bounds.y + 66);
    await expect(control).toHaveValue('31');
    await expect(control).toHaveAttribute(
      'aria-valuetext',
      '2026-07-08: Operational; 100% coverage',
    );
    await page.touchscreen.tap(bounds.x + 3, bounds.y + 110);
    await expect(control).toHaveValue('61');
    await expect(control).toHaveAttribute(
      'aria-valuetext',
      '2026-08-07: Operational; 100% coverage',
    );
    await page.touchscreen.tap(bounds.x + 3, bounds.y + 22);
    await expect(control).toHaveValue('1');
    const before = await page.evaluate(() => window.scrollY);
    const session = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    try {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      });
      for (let step = 1; step <= 6; step++)
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y - step * 20 }],
        });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await expect
        .poll(() => page.evaluate(() => window.scrollY))
        .toBeGreaterThan(before + 20);
      await expect(control).toHaveValue('1');
    } finally {
      await session.detach();
    }
  });
});
