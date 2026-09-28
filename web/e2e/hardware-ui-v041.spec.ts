import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Snapshot } from '../src/types';
import { systemCapability, systemFixture } from '../src/test/system-fixture';
import { requireNvidiaWebGL, webGLLaunchArgs } from './hardware-gpu';

test.use({
  launchOptions: {
    args: webGLLaunchArgs,
  },
});
test.beforeAll(async ({ browser }) => requireNvidiaWebGL(browser));
test.setTimeout(60_000);

const sampledAt = '2026-09-06T18:00:00.000Z';
function fixture(): Snapshot {
  const system = systemFixture(sampledAt);
  system.cpu.utilization.value = 5;
  system.memory.utilization.value = 5;
  system.storage.readBytesPerSecond.value = 1024 ** 2;
  system.storage.writeBytesPerSecond.value = 0;
  system.storage.filesystems = Array.from({ length: 9 }, (_, index) => ({
    ...system.storage.filesystems[0],
    id: `fs-${index}`,
    mountPoint: `/data/research-project-${index}/models-and-checkpoints`,
  }));
  return {
    schemaVersion: 'v1',
    sequence: 1,
    sampledAt,
    host: { hostname: 'hardware-v041', os: 'linux', arch: 'amd64' },
    system,
    gpus: [
      {
        uuid: 'GPU-v041',
        index: 0,
        name: 'NVIDIA RTX PRO 6000 Blackwell',
        migEnabled: false,
        maxMigDevices: 4,
        gpuInstances: [],
        memory: {
          totalBytes: 96 * 1024 ** 3,
          usedBytes: 24 * 1024 ** 3,
          freeBytes: 72 * 1024 ** 3,
          source: 'synthetic',
          scope: 'physical_gpu',
          sampledAt,
          status: 'available',
        },
        metrics: {
          sm_activity: {
            value: 5,
            unit: 'percent',
            source: 'synthetic',
            scope: 'physical_gpu',
            sampledAt,
            status: 'available',
          },
        },
      },
    ],
    processes: [],
    diagnostics: [],
    capabilities: {
      system: systemCapability,
      nvml: { name: 'NVML', available: true, status: 'available' },
      gpm: { name: 'GPM', available: true, status: 'available' },
      dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
      proc: { name: '/proc', available: true, status: 'available' },
      profileMetrics: false,
    },
  };
}
type FixtureWindow = Window & {
  __hardwareSnapshot: Snapshot;
  __hardwareEvents: EventTarget;
};
type Activity = {
  id: string;
  activity: number | null;
  bytesPerSecond?: number | null;
  particleCount: number;
  phase: number;
  state?: string;
  transitioning: boolean;
};

async function install(page: Page, theme: string) {
  const snapshot = fixture();
  await page.addInitScript(
    ({ theme, snapshot }) => {
      localStorage.setItem('leviathan.theme.v1', theme);
      const target = window as unknown as FixtureWindow;
      target.__hardwareSnapshot = snapshot;
      class HardwareEvents extends EventTarget {
        readonly readyState = 1;
        onopen: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        private timer: number;
        constructor() {
          super();
          target.__hardwareEvents = this;
          queueMicrotask(() => this.onopen?.(new Event('open')));
          this.timer = window.setInterval(() => {
            target.__hardwareSnapshot = {
              ...target.__hardwareSnapshot,
              sequence: target.__hardwareSnapshot.sequence + 1,
              sampledAt: new Date(
                Date.parse(target.__hardwareSnapshot.sampledAt) + 500,
              ).toISOString(),
            };
            this.dispatchEvent(
              new MessageEvent('snapshot', {
                data: JSON.stringify(target.__hardwareSnapshot),
              }),
            );
          }, 500);
        }
        close() {
          window.clearInterval(this.timer);
        }
      }
      Object.defineProperty(window, 'EventSource', {
        configurable: true,
        value: HardwareEvents,
      });
    },
    { theme, snapshot },
  );
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/snapshot')
      return route.fulfill({ json: snapshot });
    if (url.pathname === '/api/v1/settings')
      return route.fulfill({
        json: {
          samplingIntervalMs: 500,
          profileIntervalMs: 2000,
          processIntervalMs: 2000,
          historyWindowMs: 43200000,
          allowedSamplingIntervalsMs: [500, 1000, 2000],
        },
      });
    if (url.pathname === '/api/v1/version')
      return route.fulfill({
        json: {
          version: '0.4.1',
          commit: 'hardware-fixture',
          buildDate: sampledAt,
        },
      });
    if (url.pathname === '/api/v1/history/aligned') {
      const body = route.request().postDataJSON() as {
        window: string;
        series: unknown[];
      };
      return route.fulfill({ json: { ...body, points: [] } });
    }
    if (url.pathname === '/api/v1/history')
      return route.fulfill({
        json: {
          entity: url.searchParams.get('entity'),
          metrics: [],
          window: url.searchParams.get('window'),
          points: [],
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: 'unavailable in hardware fixture' },
    });
  });
  await page.goto('/#resources');
  await expect(
    page.getByRole('heading', { name: 'Resources', exact: true, level: 1 }),
  ).toBeVisible();
}
async function ready(view: Locator) {
  await view.scrollIntoViewIfNeeded();
  await expect(view).toHaveAttribute('data-render-mode', 'webgl', {
    timeout: 20_000,
  });
  await expect(view).toHaveAttribute('data-activity', /particleCount/u);
}
async function activity(view: Locator): Promise<Activity[]> {
  return JSON.parse(
    (await view.getAttribute('data-activity')) ?? '[]',
  ) as Activity[];
}
async function updateActivity(page: Page, value: number | null) {
  await page.evaluate((value) => {
    const target = window as unknown as FixtureWindow;
    const snapshot = structuredClone(target.__hardwareSnapshot);
    snapshot.gpus[0].metrics.sm_activity.value = value;
    snapshot.system.cpu.utilization.value = value;
    snapshot.system.memory.utilization.value = value;
    snapshot.system.storage.readBytesPerSecond.value =
      value == null ? null : (value / 100) * 1024 ** 3;
    snapshot.sequence++;
    snapshot.sampledAt = new Date(
      Date.parse(snapshot.sampledAt) + 1,
    ).toISOString();
    target.__hardwareSnapshot = snapshot;
    target.__hardwareEvents.dispatchEvent(
      new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }),
    );
  }, value);
}

test('static headings, centered board group, CPU focus toggle and visible Details work in both layouts', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await install(
    page,
    testInfo.project.name.endsWith('light') ? 'light' : 'dark',
  );
  const view = page.locator('.motherboard-resources .hardware-board-view');
  await ready(view);
  for (const name of ['CPU', 'RAM', 'Storage']) {
    const heading = page.getByRole('heading', { name, exact: true, level: 2 });
    await expect(heading).toHaveAttribute('tabindex', '-1');
    await expect(heading).not.toHaveAttribute('aria-pressed');
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(
      0,
    );
  }
  const geometry = await page
    .locator('.motherboard-layout')
    .evaluate((layout) => {
      const scene = layout
        .querySelector('.motherboard-scene')!
        .getBoundingClientRect();
      const view = layout
        .querySelector('.hardware-board-view')!
        .getBoundingClientRect();
      const details = layout
        .querySelector('.motherboard-details')!
        .getBoundingClientRect();
      return {
        centerError: Math.abs(
          scene.top + scene.height / 2 - view.top - view.height / 2,
        ),
        viewportHeight: layout
          .querySelector('.hardware-board-viewport')!
          .getBoundingClientRect().height,
        stacked: details.top >= view.bottom - 1,
        sceneHeight: scene.height,
        detailsHeight: details.height,
      };
    });
  if (testInfo.project.name.includes('desktop')) {
    expect(geometry.centerError).toBeLessThan(1);
    expect(geometry.sceneHeight).toBeGreaterThan(600);
    expect(geometry.viewportHeight).toBeLessThanOrEqual(460);
  } else expect(geometry.stacked).toBe(true);
  const viewport = view.locator('.hardware-board-viewport');
  await viewport.focus();
  await viewport.press('ArrowRight');
  const before = JSON.parse((await view.getAttribute('data-camera'))!) as {
    theta: number;
    phi: number;
    distance: number;
  };
  const focus = view.getByRole('button', { name: 'Focus board', exact: true });
  await focus.click();
  await expect(focus).toHaveAttribute('aria-pressed', 'true');
  await expect(view).toHaveAttribute('data-focus', 'cpu');
  const close = JSON.parse(
    (await view.getAttribute('data-camera'))!,
  ) as typeof before;
  expect(close.distance).toBeLessThan(before.distance);
  expect(close.theta).toBeCloseTo(before.theta, 6);
  expect(close.phi).toBeCloseTo(before.phi, 6);
  await focus.click();
  await expect(focus).toHaveAttribute('aria-pressed', 'false');
  await expect(view).toHaveAttribute('data-focus', 'board');
  await focus.click();
  await view.getByRole('button', { name: 'Reset view' }).click();
  await expect(view).toHaveAttribute('data-focus', 'board');
  const details = page.getByRole('button', {
    name: 'Open GPU 0 physical GPU details',
  });
  await details.scrollIntoViewIfNeeded();
  await expect(details).toHaveText('Details');
  const style = await details.evaluate((button) => ({
    height: button.getBoundingClientRect().height,
    border: getComputedStyle(button).borderTopStyle,
    borderWidth: getComputedStyle(button).borderTopWidth,
  }));
  expect(style.height).toBeGreaterThanOrEqual(44);
  expect(style.border).toBe('solid');
  expect(style.borderWidth).toBe('1px');
  await details.click();
  await expect(
    page.getByRole('heading', { name: /GPU 0/ }).last(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});

test('fresh activity strengthens GPU, CPU, RAM and SSD effects even with unknown GPU ownership', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await install(
    page,
    testInfo.project.name.endsWith('light') ? 'light' : 'dark',
  );
  const motherboard = page.locator(
    '.motherboard-resources .hardware-board-view',
  );
  const gpu = page.locator('.gpu-board-view');
  await ready(motherboard);
  await expect
    .poll(async () =>
      (await activity(motherboard)).every((state) => state.particleCount > 0),
    )
    .toBe(true);
  const lowMotherboard = await activity(motherboard);
  await ready(gpu);
  await expect
    .poll(async () => (await activity(gpu))[0]?.particleCount ?? 0)
    .toBeGreaterThan(0);
  const lowGPU = (await activity(gpu))[0];
  expect(lowGPU.state).toBe('unknown');
  await updateActivity(page, 100);
  await expect
    .poll(async () => (await activity(gpu))[0]?.particleCount)
    .toBe(64);
  expect((await activity(gpu))[0].particleCount).toBeGreaterThan(
    lowGPU.particleCount,
  );
  await page
    .locator('.gpu-card')
    .screenshot({ path: testInfo.outputPath('gpu-active.png') });
  await ready(motherboard);
  await expect
    .poll(async () =>
      (await activity(motherboard)).reduce(
        (sum, state) => sum + state.particleCount,
        0,
      ),
    )
    .toBe(48);
  const high = await activity(motherboard);
  high.forEach((state, index) =>
    expect(state.particleCount).toBeGreaterThan(
      lowMotherboard[index].particleCount,
    ),
  );
  expect(high[2].activity).toBeNull();
  expect(high[2].bytesPerSecond).toBe(1024 ** 3);
  await motherboard.screenshot({
    path: testInfo.outputPath('motherboard-active.png'),
  });
  const phase = high[0].phase;
  await expect
    .poll(async () => (await activity(motherboard))[0].phase)
    .toBeGreaterThan(phase);
  await updateActivity(page, null);
  await expect
    .poll(async () =>
      (await activity(motherboard)).every((state) => state.particleCount === 0),
    )
    .toBe(true);
  await ready(gpu);
  await expect.poll(async () => (await activity(gpu))[0].particleCount).toBe(0);
  await updateActivity(page, 100);
  await expect
    .poll(async () => (await activity(gpu))[0].particleCount)
    .toBe(64);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await activity(gpu))[0].particleCount).toBe(0);
  expect((await activity(gpu))[0].activity).toBe(100);
  await ready(motherboard);
  await expect
    .poll(async () =>
      (await activity(motherboard)).every((state) => state.particleCount === 0),
    )
    .toBe(true);
  await expect(page.locator('canvas.hardware-board-canvas')).toHaveCount(1);
});

test('forced colors keeps static native headings and complete motherboard fallback facts', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await install(
    page,
    testInfo.project.name.endsWith('light') ? 'light' : 'dark',
  );
  const panel = page.locator('.motherboard-resources');
  await expect(panel.locator('.hardware-board-view')).toHaveAttribute(
    'data-render-mode',
    'fallback',
  );
  await expect(
    panel.getByRole('button', { name: 'Focus board' }),
  ).toBeDisabled();
  await expect(panel.locator('.motherboard-fallback')).toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'CPU', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'Storage', exact: true }),
  ).toBeVisible();
  await expect(panel).toContainText(
    '/data/research-project-8/models-and-checkpoints',
  );
});
