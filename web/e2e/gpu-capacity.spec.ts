import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { systemCapability, systemFixture } from '../src/test/system-fixture';
import type { Snapshot } from '../src/types';
import type { GPUCapacity } from '../src/gpu-capacity';

function capacity(): GPUCapacity {
  return {
    status: 'available',
    observedAt: new Date().toISOString(),
    revision: 3,
    rows: [
      {
        id: 'native',
        mode: 'native',
        model: 'Synthetic 80 GiB GPU',
        memoryBytes: 80 * 1024 ** 3,
        available: 2,
        status: 'available',
      },
      ...[80, 40, 20].map((memory, index) => ({
        id: `mig-${memory}`,
        mode: 'mig' as const,
        model: 'Synthetic 80 GiB GPU',
        profile: `${[7, 3, 1][index]}g.${memory}gb`,
        memoryBytes: memory * 1024 ** 3,
        available: [2, 4, 8][index],
        status: 'available' as const,
      })),
    ],
  };
}

async function installBackend(page: Page, theme: 'dark' | 'light') {
  const sampledAt = new Date().toISOString();
  const snapshot: Snapshot = {
    schemaVersion: 'v1',
    sequence: 1,
    sampledAt,
    host: { hostname: 'capacity-fixture', os: 'linux', arch: 'amd64' },
    system: systemFixture(sampledAt),
    processes: [],
    diagnostics: [],
    capabilities: {
      system: systemCapability,
      nvml: { name: 'NVML', available: true, status: 'available' },
      gpm: { name: 'GPM', available: false, status: 'unsupported' },
      dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
      proc: { name: '/proc', available: true, status: 'available' },
      profileMetrics: false,
    },
    gpus: [
      {
        uuid: 'GPU-capacity',
        index: 0,
        name: 'Synthetic 80 GiB GPU',
        migEnabled: false,
        maxMigDevices: 0,
        memory: {
          totalBytes: 80 * 1024 ** 3,
          usedBytes: 0,
          freeBytes: 80 * 1024 ** 3,
          source: 'synthetic',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        metrics: {},
        gpuInstances: [],
      },
    ],
  };
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem('leviathan.theme.v1', selectedTheme);
    // These cases inspect native capacity controls; hardware WebGL has its own suite.
    const getContext = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'getContext',
    )!.value as HTMLCanvasElement['getContext'];
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      options?: unknown,
    ) {
      return kind.includes('webgl')
        ? null
        : Reflect.apply(getContext, this, [kind, options]);
    } as typeof getContext;
    class QuietEventSource extends EventTarget {
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      close() {}
    }
    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: QuietEventSource,
    });
  }, theme);
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case '/api/v1/snapshot':
        return route.fulfill({ json: snapshot });
      case '/api/v1/settings':
        return route.fulfill({
          json: {
            samplingIntervalMs: 500,
            profileIntervalMs: 2000,
            processIntervalMs: 2000,
            historyWindowMs: 43200000,
            allowedSamplingIntervalsMs: [500, 1000, 2000],
          },
        });
      case '/api/v1/version':
        return route.fulfill({
          json: {
            version: '0.4.1',
            commit: 'capacity-fixture',
            buildDate: sampledAt,
          },
        });
      case '/api/v1/gpu-capacity':
        return route.fulfill({ json: capacity() });
      case '/api/v1/history/aligned': {
        const request = route.request().postDataJSON();
        return route.fulfill({
          json: { window: request.window, series: request.series, points: [] },
        });
      }
      case '/api/v1/history':
        return route.fulfill({
          json: {
            entity: url.searchParams.get('entity'),
            window: url.searchParams.get('window'),
            metrics: [],
            points: [],
          },
        });
      default:
        return route.fulfill({ status: 404, json: { error: 'not found' } });
    }
  });
}

test.beforeEach(async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installBackend(
    page,
    info.project.name.endsWith('-light') ? 'light' : 'dark',
  );
});

async function openPanel(page: Page) {
  await page.goto('/#resources');
  const panel = page.getByTestId('gpu-capacity-panel');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toHaveAttribute('data-status', 'available');
  return panel;
}

test('capacity fills a complete row between the GPUs heading and hardware cards', async ({
  page,
}, info) => {
  const panel = await openPanel(page);
  const layout = await panel.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const heading = document
      .getElementById('resource-gpu')!
      .getBoundingClientRect();
    const card = document.querySelector('.gpu-card')!.getBoundingClientRect();
    const rows = [...element.querySelectorAll('.gpu-capacity-row')].map(
      (row) => row.getBoundingClientRect().top,
    );
    return {
      top: box.top,
      bottom: box.bottom,
      headingBottom: heading.bottom,
      cardTop: card.top,
      rows,
    };
  });
  expect(layout.top).toBeGreaterThanOrEqual(layout.headingBottom);
  expect(layout.bottom).toBeLessThanOrEqual(layout.cardTop);
  expect(new Set(layout.rows).size).toBe(
    info.project.name.includes('narrow') ? 4 : 1,
  );
  await expect(panel.locator('[data-available="2"]')).toHaveCount(2);
  await expect(panel.locator('[data-available="4"]')).toHaveCount(1);
  await expect(panel.locator('[data-available="8"]')).toHaveCount(1);
  const button = panel.getByRole('button', {
    name: 'Refresh live GPU capacity',
  });
  await expect(button).toBeEnabled();
  const target = await button.boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);
  await button.focus();
  await expect(button).toBeFocused();
  await panel.screenshot({
    path: info.outputPath('live-gpu-capacity.png'),
    animations: 'disabled',
  });
  const accessibility = await new AxeBuilder({ page })
    .include('.gpu-capacity-panel')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test('stale and failed refreshes suppress old counts and a manual refresh recovers', async ({
  page,
}) => {
  const panel = await openPanel(page);
  const response = capacity();
  response.status = 'stale';
  response.message = 'Waiting for a fresh Kubernetes observation.';
  await page.route('**/api/v1/gpu-capacity', (route) =>
    route.fulfill({ json: response }),
  );
  const refresh = panel.getByRole('button', {
    name: 'Refresh live GPU capacity',
  });
  await refresh.click();
  await expect(panel).toHaveAttribute('data-status', 'stale');
  await expect(panel.locator('[data-available="unknown"]')).toHaveCount(4);
  await page.route('**/api/v1/gpu-capacity', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await refresh.click();
  await expect(panel).toHaveAttribute('data-status', 'unavailable');
  await expect(panel.locator('[data-available="unknown"]')).toHaveCount(4);
  await page.route('**/api/v1/gpu-capacity', (route) =>
    route.fulfill({ json: capacity() }),
  );
  await refresh.click();
  await expect(panel).toHaveAttribute('data-status', 'available');
  await expect(panel.locator('[data-available="8"]')).toHaveCount(1);
});

test('capacity remains readable at 320px and with enlarged text', async ({
  page,
}) => {
  const panel = await openPanel(page);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '24px';
    });
    await panel.scrollIntoViewIfNeeded();
    const bounds = await panel.evaluate((element) => ({
      scroll: document.documentElement.scrollWidth,
      viewport: innerWidth,
      clipped: [
        ...element.querySelectorAll<HTMLElement>('dt,dd,button,p'),
      ].some((node) => node.scrollWidth > node.clientWidth + 1),
    }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.clipped).toBe(false);
  }
});
