import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { GPU, Snapshot } from '../src/types';
import { systemCapability, systemFixture } from '../src/test/system-fixture';

// Exercise real Three/WebGL scenes on the Linux browser platform, including CI
// machines without a hardware GPU. Fallback is covered in dedicated cases only.
test.use({
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  },
});
test.setTimeout(90_000);

const sampledAt = '2026-09-05T06:00:00.000Z';
function makeGPU(index: number, migEnabled: boolean): GPU {
  const uuid = `GPU-refinement-${index}`;
  const memory = {
    totalBytes: 96 * 1024 ** 3,
    usedBytes: 24 * 1024 ** 3,
    freeBytes: 72 * 1024 ** 3,
    source: 'synthetic' as const,
    scope: 'physical_gpu' as const,
    sampledAt,
    status: 'available' as const,
  };
  const metric = (value: number, unit: string) => ({
    value,
    unit,
    source: 'synthetic' as const,
    scope: 'physical_gpu' as const,
    sampledAt,
    status: 'available' as const,
  });
  return {
    uuid,
    index,
    name: 'NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition',
    migEnabled,
    maxMigDevices: migEnabled ? 4 : 0,
    memory,
    metrics: {
      gpu_activity: metric(25, 'percent'),
      sm_activity: metric(20, 'percent'),
      temperature: metric(48, 'celsius'),
      power: metric(90, 'watts'),
      power_limit: metric(300, 'watts'),
    },
    gpuInstances:
      index === 1
        ? [0, 1].map((id) => ({
            uuid: `${uuid}/gi/${id}`,
            id,
            profile: '1g.24gb',
            generation: `${uuid}/gi/${id}@1`,
            memory: {
              ...memory,
              scope: 'gpu_instance' as const,
              totalBytes: 24 * 1024 ** 3,
              usedBytes: 6 * 1024 ** 3,
              freeBytes: 18 * 1024 ** 3,
            },
            metrics: {
              sm_activity: {
                ...metric(30, 'percent'),
                scope: 'gpu_instance' as const,
              },
            },
            computeInstances: [
              {
                uuid: `MIG-refinement-${id}`,
                id: 0,
                profile: '1c.1g.24gb',
                generation: `MIG-refinement-${id}@1`,
                memory: {
                  ...memory,
                  scope: 'gpu_instance' as const,
                  status: 'unsupported' as const,
                  totalBytes: null,
                  usedBytes: null,
                  freeBytes: null,
                },
                metrics: {},
              },
            ],
          }))
        : [],
  };
}
const snapshot: Snapshot = {
  schemaVersion: 'v1',
  sequence: 42,
  sampledAt,
  host: { hostname: 'gpu-refinement-host', os: 'linux', arch: 'amd64' },
  system: systemFixture(sampledAt),
  gpus: [
    makeGPU(0, false),
    makeGPU(1, true),
    makeGPU(2, true),
    makeGPU(3, false),
  ],
  processes: [],
  diagnostics: [],
  capabilities: {
    system: systemCapability,
    nvml: { name: 'NVML', available: true, status: 'available' },
    gpm: { name: 'GPM', available: true, status: 'available' },
    dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
    proc: { name: '/proc', available: true, status: 'available' },
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
    workloads: [
      {
        ref: 'workspace-refinement',
        platform: 'coder',
        kind: 'workspace',
        name: 'training',
        ownerName: 'fixture-owner',
      },
    ],
    assignments: [
      {
        workloadRef: 'workspace-refinement',
        entityType: 'physical_gpu',
        entityUuid: 'GPU-refinement-0',
        state: 'allocated',
      },
      {
        workloadRef: 'workspace-refinement',
        entityType: 'compute_instance',
        entityUuid: 'MIG-refinement-0',
        state: 'reserved',
      },
    ],
  },
};

type FixtureWindow = Window & {
  __gpuEvents: EventTarget;
  __gpuOriginalControl?: Element;
  __gpuOriginalCI?: Element;
  __gpuContexts: unknown[];
  __gpuLostExtension?: WEBGL_lose_context;
  __gpuCanvasHiddenOnRemoval?: boolean | null;
  __gpuScissors: number[][];
  __gpuViewports: number[][];
  __gpuHoldFrames: boolean;
  __gpuResumeFrames: () => void;
  __gpuContextAttempts: number;
  __gpuDraws: number;
  __gpuSequence: number;
  __gpuSampleTime: number;
  __gpuSnapshot?: Snapshot;
  __gpuHeartbeatPaused: boolean;
  __LEVIATHAN_TEST_SNOW_SEED__: number;
};

async function installBackend(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem('leviathan.theme.v1', selectedTheme);
    const target = window as unknown as FixtureWindow;
    target.__LEVIATHAN_TEST_SNOW_SEED__ = 481516;
    target.__gpuContextAttempts = 0;
    target.__gpuDraws = 0;
    target.__gpuSequence = 0;
    target.__gpuSampleTime = 0;
    target.__gpuHeartbeatPaused = false;
    target.__gpuContexts = [];
    target.__gpuScissors = [];
    target.__gpuViewports = [];
    target.__gpuHoldFrames = false;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const requestFrame = window.requestAnimationFrame.bind(window);
    const cancelFrame = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const id = requestFrame((time) => {
        if (target.__gpuHoldFrames) pendingFrames.set(id, callback);
        else callback(time);
      });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pendingFrames.delete(id);
      cancelFrame(id);
    };
    target.__gpuResumeFrames = () => {
      target.__gpuHoldFrames = false;
      const callbacks = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const callback of callbacks) requestFrame(callback);
    };
    class StableEventSource extends EventTarget {
      readonly readyState = 1;
      private closed = false;
      private heartbeat: number | undefined;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(readonly url: string) {
        super();
        target.__gpuEvents = this;
        queueMicrotask(() => this.onopen?.(new Event('open')));
        // A transport connection is not a fresh telemetry observation. Deliver
        // a newer SSE sample after the HTTP fixture, matching the live server.
        void fetch('/api/v1/snapshot')
          .then((response) => response.json())
          .then((value: Snapshot) => {
            if (this.closed) return;
            const next = {
              ...value,
              sequence: value.sequence + 1,
              sampledAt: new Date(
                Date.parse(value.sampledAt) + 1,
              ).toISOString(),
            };
            target.__gpuSequence = next.sequence;
            target.__gpuSampleTime = Date.parse(next.sampledAt);
            target.__gpuSnapshot = next;
            this.dispatchEvent(
              new MessageEvent('snapshot', { data: JSON.stringify(next) }),
            );
            this.heartbeat = window.setInterval(() => {
              if (target.__gpuHeartbeatPaused || !target.__gpuSnapshot) return;
              const update = {
                ...target.__gpuSnapshot,
                sequence: ++target.__gpuSequence,
                sampledAt: new Date(
                  target.__gpuSampleTime + 1000,
                ).toISOString(),
              };
              target.__gpuSampleTime = Date.parse(update.sampledAt);
              target.__gpuSnapshot = update;
              this.dispatchEvent(
                new MessageEvent('snapshot', { data: JSON.stringify(update) }),
              );
            }, 1000);
          });
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
    const prototype = HTMLCanvasElement.prototype;
    const getContext = Object.getOwnPropertyDescriptor(prototype, 'getContext')!
      .value as HTMLCanvasElement['getContext'];
    Object.defineProperty(prototype, 'getContext', {
      configurable: true,
      value(this: HTMLCanvasElement, type: string, options?: unknown) {
        if (['webgl', 'webgl2', 'experimental-webgl'].includes(type)) {
          target.__gpuContextAttempts++;
        }
        const context = Reflect.apply(getContext, this, [type, options]);
        if (
          ['webgl', 'webgl2', 'experimental-webgl'].includes(type) &&
          context &&
          !target.__gpuContexts.includes(context)
        )
          target.__gpuContexts.push(context);
        return context;
      },
    });
    const originalViewport = Object.getOwnPropertyDescriptor(
      WebGL2RenderingContext.prototype,
      'viewport',
    )!.value as WebGL2RenderingContext['viewport'];
    WebGL2RenderingContext.prototype.viewport = function (x, y, width, height) {
      target.__gpuViewports.push([x, y, width, height]);
      if (target.__gpuViewports.length > 256) target.__gpuViewports.shift();
      return originalViewport.call(this, x, y, width, height);
    };
    const originalScissor = Object.getOwnPropertyDescriptor(
      WebGL2RenderingContext.prototype,
      'scissor',
    )!.value as WebGL2RenderingContext['scissor'];
    WebGL2RenderingContext.prototype.scissor = function (x, y, width, height) {
      target.__gpuScissors.push([x, y, width, height]);
      if (target.__gpuScissors.length > 256) target.__gpuScissors.shift();
      return originalScissor.call(this, x, y, width, height);
    };
    for (const method of [
      'drawElements',
      'drawElementsInstanced',
      'drawArrays',
      'drawArraysInstanced',
    ] as const) {
      const original = WebGL2RenderingContext.prototype[method];
      Object.defineProperty(WebGL2RenderingContext.prototype, method, {
        configurable: true,
        value(this: WebGL2RenderingContext, ...args: unknown[]) {
          target.__gpuDraws++;
          return Reflect.apply(original, this, args);
        },
      });
    }
  }, theme);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
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
          version: '0.4.0',
          commit: 'gpu-panel-fixture',
          buildDate: sampledAt,
        },
      });
    if (url.pathname === '/api/v1/history/aligned') {
      const body = request.postDataJSON() as {
        window: string;
        series: unknown[];
      };
      return route.fulfill({
        json: { window: body.window, series: body.series, points: [] },
      });
    }
    if (url.pathname === '/api/v1/history')
      return route.fulfill({
        json: {
          entity: url.searchParams.get('entity'),
          metrics: (url.searchParams.get('metrics') ?? '').split(','),
          window: url.searchParams.get('window'),
          points: [],
        },
      });
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

function gpuCard(page: Page, index: number) {
  return page.locator('.gpu-card').filter({
    has: page.getByRole('button', {
      name: `Open GPU ${index} physical GPU details`,
      exact: true,
    }),
  });
}
async function openResources(page: Page) {
  await page.goto('/#resources');
  await expect(
    page.getByRole('heading', { name: 'Resources', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.locator('.gpu-card')).toHaveCount(4);
}
async function sendSnapshot(page: Page, next: Snapshot) {
  await page.evaluate((value) => {
    const target = window as unknown as FixtureWindow;
    const sample = {
      ...value,
      sequence: Math.max(value.sequence, target.__gpuSequence + 1),
      sampledAt: new Date(
        Math.max(Date.parse(value.sampledAt), target.__gpuSampleTime + 1),
      ).toISOString(),
    };
    target.__gpuSequence = sample.sequence;
    target.__gpuSampleTime = Date.parse(sample.sampledAt);
    target.__gpuSnapshot = sample;
    target.__gpuEvents.dispatchEvent(
      new MessageEvent('snapshot', { data: JSON.stringify(sample) }),
    );
  }, next);
}

test.beforeEach(async ({ page }, testInfo) => {
  await installBackend(
    page,
    testInfo.project.name.endsWith('-light') ? 'light' : 'dark',
  );
});

function board(page: Page, index: number) {
  return gpuCard(page, index).locator('.gpu-board-view');
}
async function readyBoard(page: Page, index: number) {
  const view = board(page, index);
  await view.scrollIntoViewIfNeeded();
  await expect(view).toHaveAttribute('data-render-mode', 'webgl', {
    timeout: 20_000,
  });
  await expect(page.locator('canvas.gpu-board-canvas')).toHaveCount(1);
  await expect(view).toHaveAttribute('data-camera', /distance/u);
  return view;
}
async function enableInteraction(view: Locator) {
  const interact = view.getByRole('button', { name: 'Interact', exact: true });
  if (await interact.isVisible()) await interact.click();
}
async function projectedChip(view: Locator, key: string) {
  await expect
    .poll(async () => {
      const targets = JSON.parse(
        (await view.getAttribute('data-chip-targets')) ?? '[]',
      ) as Array<{ key: string; visible: boolean }>;
      return targets.some((target) => target.key === key && target.visible);
    })
    .toBe(true);
  const targets = JSON.parse(
    (await view.getAttribute('data-chip-targets'))!,
  ) as Array<{ key: string; x: number; y: number }>;
  return targets.find((target) => target.key === key)!;
}

type ChipAppearance = {
  id: string;
  state: 'assigned' | 'reserved' | 'unassigned' | 'unknown';
  activity: number | null;
  emissiveIntensity: number;
  particleCount: number;
  phase: number;
  transitioning: boolean;
};
async function chipAppearance(view: Locator, id: string) {
  await expect(view).toHaveAttribute('data-activity', /emissiveIntensity/u);
  const regions = JSON.parse(
    (await view.getAttribute('data-activity'))!,
  ) as ChipAppearance[];
  const region = regions.find((candidate) => candidate.id === id);
  expect(region, `Material diagnostics for ${id}`).toBeDefined();
  return region!;
}
function idleSnapshot() {
  const idle = structuredClone(snapshot);
  for (const gpu of idle.gpus) {
    gpu.metrics.sm_activity.value = 0;
    for (const gi of gpu.gpuInstances) gi.metrics.sm_activity.value = 0;
  }
  return idle;
}
async function hardwareClipTop(page: Page) {
  return page
    .locator('.leviathan-header,.workbench-nav')
    .evaluateAll((elements) =>
      Math.max(
        0,
        ...elements.map((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const inset = Number.parseFloat(style.top);
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            ['sticky', 'fixed'].includes(style.position) &&
            Number.isFinite(inset) &&
            rect.top <= inset + 1 &&
            rect.top < innerHeight / 2
            ? rect.bottom
            : 0;
        }),
      ),
    );
}

async function expectNoWebGLDraws(page: Page) {
  // Let the bounded appearance/layout transitions finish, then observe an idle
  // interval. This catches runaway render loops even when one view is hidden.
  const clipTop = await hardwareClipTop(page);
  await expect(async () => {
    expect(
      await page.locator('.hardware-board-view[data-activity]').evaluateAll(
        (views, top) =>
          views
            .filter((view) => {
              const bounds = view
                .querySelector('.hardware-board-viewport')!
                .getBoundingClientRect();
              return bounds.bottom > top && bounds.top < innerHeight;
            })
            .every((view) =>
              (
                JSON.parse(
                  view.getAttribute('data-activity')!,
                ) as ChipAppearance[]
              ).every((region) => !region.transitioning),
            ),
        clipTop,
      ),
    ).toBe(true);
    // A scroll or resize can still have a queued final redraw after appearance
    // transitions stop. Require a quiet interval instead of assuming it has run.
    const before = await page.evaluate(
      () => (window as unknown as FixtureWindow).__gpuDraws,
    );
    await page.waitForTimeout(450);
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).__gpuDraws,
      ),
    ).toBe(before);
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).__gpuDraws,
      ),
    ).toBe(before);
  }).toPass({ timeout: 10_000 });
}
async function captureChipState(view: Locator, path: string) {
  await view.locator('.gpu-board-viewport').evaluate(async (element) => {
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await view.screenshot({ path });
}
async function closeDetail(page: Page) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function showFullBoard(page: Page, view: Locator) {
  const toggle = view.getByRole('button', { name: 'Focus chip', exact: true });
  await expect(view).toHaveAttribute('data-focus', 'chip');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(view).toHaveAttribute('data-focus', 'board');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.blur();
  await page.mouse.move(0, 0);
  await view.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function expectCompleteBoard(view: Locator) {
  await expect(view).toHaveAttribute('data-board-bounds', /left/u);
  const bounds = JSON.parse(
    (await view.getAttribute('data-board-bounds'))!,
  ) as {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  // Projected exterior corners, not only chip centers, must remain in frame.
  expect(bounds.left).toBeGreaterThan(-1);
  expect(bounds.right).toBeLessThan(1);
  expect(bounds.top).toBeLessThan(1);
  expect(bounds.bottom).toBeGreaterThan(-1);
  expect(
    Math.max(bounds.right - bounds.left, bounds.top - bounds.bottom) / 2,
  ).toBeGreaterThanOrEqual(0.8);
}

test('full and MIG boards render real WebGL scenes through one shared clipped canvas', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  const first = await readyBoard(page, 0);
  await expect(
    gpuCard(page, 0).locator('.gpu-full-chip-button .gpu-allocation-label'),
  ).toHaveText('Assigned');
  await showFullBoard(page, first);
  await expectCompleteBoard(first);
  await expect(page.locator('.gpu-board-view')).toHaveCount(4);
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).__gpuContexts.length,
    ),
  ).toBe(1);
  expect(
    await page
      .locator('canvas.gpu-board-canvas')
      .evaluate((canvas: HTMLCanvasElement) => {
        const gl = canvas.getContext('webgl2');
        return Boolean(
          gl &&
          !gl.isContextLost() &&
          String(gl.getParameter(gl.VERSION)).includes('WebGL 2'),
        );
      }),
  ).toBe(true);
  const style = await page.addStyleTag({
    content:
      '.workbench-nav,.mobile-workbench-nav,.leviathan-header,canvas.ambient-snow {visibility:hidden!important}',
  });
  try {
    await expect(first).toHaveScreenshot('gpu-board-webgl-full.png', {
      animations: 'disabled',
    });
    const mig = await readyBoard(page, 1);
    await showFullBoard(page, mig);
    await expectCompleteBoard(mig);
    await expect(mig).toHaveScreenshot('gpu-board-webgl-mig.png', {
      animations: 'disabled',
    });
    await expect(gpuCard(page, 1)).toHaveScreenshot(
      'gpu-board-assignment-badges.png',
      {
        animations: 'disabled',
      },
    );
  } finally {
    await style.evaluate((element) => element.parentNode?.removeChild(element));
  }
  await readyBoard(page, 3);
  expect(
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas.gpu-board-canvas',
      )!;
      const scissors = (window as unknown as FixtureWindow).__gpuScissors;
      return (
        scissors.length > 0 &&
        scissors.every(
          ([x, y, w, h]) =>
            x >= 0 &&
            y >= 0 &&
            w > 0 &&
            h > 0 &&
            x + w <= canvas.width + 1 &&
            y + h <= canvas.height + 1,
        )
      );
    }),
  ).toBe(true);
  const accessibility = await new AxeBuilder({ page })
    .include('.gpu-card')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test('chip focus is the initial view and reset target while remembered board inspection survives navigation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  let view = await readyBoard(page, 1);
  await expect(view).toHaveAttribute('data-focus', 'chip');
  await expect(
    view.getByRole('button', { name: 'Focus chip', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const initial = JSON.parse(
    (await view.getAttribute('data-camera'))!,
  ) as Record<string, number>;
  await showFullBoard(page, view);
  await expectCompleteBoard(view);
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const remembered = JSON.parse(
    (await view.getAttribute('data-camera'))!,
  ) as Record<string, number>;
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.gpu-board-view')).toHaveCount(0);
  await page.getByRole('link', { name: 'Resources', exact: true }).click();
  view = await readyBoard(page, 1);
  await expect(view).toHaveAttribute('data-focus', 'board');
  const restored = JSON.parse(
    (await view.getAttribute('data-camera'))!,
  ) as Record<string, number>;
  for (const key of ['theta', 'phi', 'distance'])
    expect(restored[key]).toBeCloseTo(remembered[key]!, 8);
  await view.getByRole('button', { name: 'Reset view', exact: true }).click();
  await expect(view).toHaveAttribute('data-focus', 'chip');
  const reset = JSON.parse((await view.getAttribute('data-camera'))!) as Record<
    string,
    number
  >;
  for (const key of ['theta', 'phi', 'distance'])
    expect(reset[key]).toBeCloseTo(initial[key]!, 8);
  await showFullBoard(page, view);
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const viewport = view.locator('.gpu-board-viewport');
  await viewport.focus();
  await viewport.press('Home');
  await expect(view).toHaveAttribute('data-focus', 'chip');
  const home = JSON.parse((await view.getAttribute('data-camera'))!) as Record<
    string,
    number
  >;
  for (const key of ['theta', 'phi', 'distance'])
    expect(home[key]).toBeCloseTo(initial[key]!, 8);
  await expect(
    view.getByRole('button', { name: 'Focus chip', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('raycast picking selects the correct chip after rotation zoom and scrolling without opening after drag', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  const view = await readyBoard(page, 1);
  await enableInteraction(view);
  const viewport = view.locator('.gpu-board-viewport');
  const before = await view.getAttribute('data-camera');
  const rect = (await viewport.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    rect.x + rect.width / 2 + 45,
    rect.y + rect.height / 2 + 12,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect(view).not.toHaveAttribute('data-camera', before!);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const rotated = await view.getAttribute('data-camera');
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(view).not.toHaveAttribute('data-camera', rotated!);
  await page.evaluate(() => window.scrollBy(0, 48));
  const button = gpuCard(page, 1).getByRole('button', {
    name: 'Open GPU 1 · GI 1 · CI 0 details',
    exact: true,
  });
  const key = (await button.getAttribute('data-chip-key'))!;
  const point = await projectedChip(view, key);
  await viewport.click({ position: { x: point.x, y: point.y } });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('GI 1');
  await expect(dialog).toContainText('CI 0');
});

test('scrolling keeps painted boards attached to their cards before redraw and preserves camera framing', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  const view = await readyBoard(page, 1);
  const viewport = view.locator('.gpu-board-viewport');
  await viewport.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const camera = await view.getAttribute('data-camera');
  const canvas = page.locator('canvas.gpu-board-canvas');
  const originalScrollHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  try {
    for (const distance of [72, -48, 56]) {
      const beforeView = (await viewport.boundingBox())!;
      const beforeCanvas = (await canvas.boundingBox())!;
      const beforeScroll = await page.evaluate(() => {
        (window as unknown as FixtureWindow).__gpuHoldFrames = true;
        return window.scrollY;
      });
      await page.evaluate((offset) => window.scrollBy(0, offset), distance);
      await expect
        .poll(() => page.evaluate(() => window.scrollY))
        .toBe(beforeScroll + distance);
      const heldView = (await viewport.boundingBox())!;
      const heldCanvas = (await canvas.boundingBox())!;
      expect(heldView.y - beforeView.y).toBeCloseTo(-distance, 3);
      // Existing pixels must follow the DOM even when the renderer cannot draw.
      // A fixed canvas fails this check by remaining at the previous screen y.
      expect(heldCanvas.y - beforeCanvas.y).toBeCloseTo(
        heldView.y - beforeView.y,
        3,
      );
      await expect(view).toHaveAttribute('data-camera', camera!);
      await page.evaluate(() => {
        const state = window as unknown as FixtureWindow;
        state.__gpuViewports = [];
        state.__gpuResumeFrames();
      });
      await expect
        .poll(() =>
          viewport.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const surface = document.querySelector<HTMLCanvasElement>(
              'canvas.gpu-board-canvas',
            )!;
            const canvasRect = surface.getBoundingClientRect();
            const ratio = surface.width / canvasRect.width;
            const expected = [
              (rect.left - canvasRect.left) * ratio,
              surface.height - (rect.bottom - canvasRect.top) * ratio,
              rect.width * ratio,
              rect.height * ratio,
            ];
            return (window as unknown as FixtureWindow).__gpuViewports.some(
              (actual) =>
                actual.every(
                  (value, index) => Math.abs(value - expected[index]!) <= 1,
                ),
            );
          }),
        )
        .toBe(true);
      await expect(view).toHaveAttribute('data-camera', camera!);
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight),
      ).toBe(originalScrollHeight);
    }
  } finally {
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).__gpuResumeFrames(),
    );
  }
  await enableInteraction(view);
  const point = await projectedChip(view, 'MIG-refinement-1');
  await viewport.click({ position: { x: point.x, y: point.y } });
  await expect(page.getByRole('dialog')).toContainText('GI 1');
  await closeDetail(page);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await readyBoard(page, 3);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    originalScrollHeight,
  );
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.gpu-board-view')).toHaveCount(0);
  await expect(page.locator('canvas.gpu-board-canvas')).toBeHidden();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('native chip controls support keyboard selection and highlight the matching 3D chip', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  for (const index of [0, 1]) {
    const view = await readyBoard(page, index);
    const button =
      index === 0
        ? gpuCard(page, 0).locator('.gpu-full-chip-button')
        : gpuCard(page, 1).getByRole('button', {
            name: 'Open GPU 1 · GI 0 · CI 0 details',
            exact: true,
          });
    await page.keyboard.press('Tab');
    await button.focus();
    await expect(view).toHaveAttribute(
      'data-highlighted-chip',
      (await button.getAttribute('data-chip-key'))!,
    );
    await expect(
      gpuCard(page, index).locator('.gpu-chip-summary'),
    ).toBeVisible();
    const bounds = (await button.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await button.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await closeDetail(page);
    await expect(button).toBeFocused();
  }
  await expect(gpuCard(page, 2)).toContainText('No observed MIG instances');
});

test('polling and topology changes preserve the camera and unaffected keyboard controls', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  const view = await readyBoard(page, 1);
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const stable = gpuCard(page, 1).getByRole('button', {
    name: 'Open GPU 1 · GI 1 · CI 0 details',
    exact: true,
  });
  await stable.focus();
  const camera = await view.getAttribute('data-camera');
  await stable.evaluate((element) => {
    (window as unknown as FixtureWindow).__gpuOriginalControl = element;
  });
  const changed = gpuCard(page, 1).getByRole('button', {
    name: 'Open GPU 1 · GI 0 · CI 0 details',
    exact: true,
  });
  await changed.evaluate((element) => {
    (window as unknown as FixtureWindow).__gpuOriginalCI = element;
  });
  for (let index = 0; index < 3; index++) {
    const update = structuredClone(snapshot);
    update.sequence += index + 1;
    update.sampledAt = new Date(
      Date.parse(sampledAt) + (index + 1) * 1000,
    ).toISOString();
    update.gpus[1].gpuInstances[1].memory.usedBytes = (7 + index) * 1024 ** 3;
    await sendSnapshot(page, update);
    await expect(gpuCard(page, 1).locator('.gpu-chip-summary')).toContainText(
      `${7 + index}.0 GiB`,
    );
    await expect(stable).toBeFocused();
    expect(
      await stable.evaluate(
        (element) =>
          element === (window as unknown as FixtureWindow).__gpuOriginalControl,
      ),
    ).toBe(true);
    await expect(view).toHaveAttribute('data-camera', camera!);
  }
  const replacement = structuredClone(snapshot);
  replacement.sequence += 10;
  replacement.gpus[1].gpuInstances[0].generation = 'GI-replacement@2';
  replacement.gpus[1].gpuInstances[0].computeInstances[0].generation =
    'CI-replacement@2';
  await sendSnapshot(page, replacement);
  await expect
    .poll(() =>
      changed.evaluate(
        (element) =>
          element === (window as unknown as FixtureWindow).__gpuOriginalCI,
      ),
    )
    .toBe(false);
  await expect(stable).toBeFocused();
  expect(
    await stable.evaluate(
      (element) =>
        element === (window as unknown as FixtureWindow).__gpuOriginalControl,
    ),
  ).toBe(true);
  await expect(view).toHaveAttribute('data-camera', camera!);
});

test('shared GI memory appears once in the focused chip summary with every CI inspectable', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const multiple = structuredClone(snapshot);
  const gi = multiple.gpus[1].gpuInstances[0];
  gi.computeInstances.push({
    ...structuredClone(gi.computeInstances[0]),
    uuid: 'MIG-refinement-sibling',
    generation: 'MIG-refinement-sibling@1',
    id: 1,
  });
  const secondGI = multiple.gpus[1].gpuInstances[1];
  secondGI.computeInstances.push({
    ...structuredClone(secondGI.computeInstances[0]),
    uuid: 'MIG-refinement-second-sibling',
    generation: 'MIG-refinement-second-sibling@1',
    id: 1,
  });
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: multiple }),
  );
  await openResources(page);
  await expect(gpuCard(page, 1).locator('.gpu-ci-button')).toHaveCount(4);
  for (const id of [0, 1]) {
    const button = gpuCard(page, 1).getByRole('button', {
      name: `Open GPU 1 · GI 0 · CI ${id} details`,
      exact: true,
    });
    await button.focus();
    const summary = gpuCard(page, 1).locator('.gpu-chip-summary');
    await expect(summary.getByText(/Shared GI \d+ memory/u)).toHaveCount(1);
    await expect(summary).toContainText('6.0 GiB');
    await expect(button.locator('[role="progressbar"]')).toHaveCount(0);
    await button.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await closeDetail(page);
  }
  const view = await readyBoard(page, 1);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.mouse.move(0, 0);
  await expect(view).toHaveAttribute('data-focus', 'chip');
  await expect(
    view.getByRole('button', { name: 'Focus chip', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await view.locator('.gpu-board-viewport').evaluate(async (element) => {
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const keys = await gpuCard(page, 1)
    .locator('.gpu-ci-button')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('data-chip-key')!),
    );
  const points = await Promise.all(keys.map((key) => projectedChip(view, key)));
  expect(points).toHaveLength(4);
  const [a, b, c, d] = points;
  // Adjacent rows and columns must form a plane, not one strip of regions.
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  expect(area).toBeGreaterThan(100);
  expect((b.x - a.x) * (d.x - c.x)).toBeGreaterThan(0);
  expect((c.y - a.y) * (d.y - b.y)).toBeGreaterThan(0);
  if (testInfo.project.name === 'chromium-desktop-dark') {
    const style = await page.addStyleTag({
      content:
        '.workbench-nav,.mobile-workbench-nav,.leviathan-header,canvas.ambient-snow {visibility:hidden!important}',
    });
    try {
      await expect(view).toHaveScreenshot(
        'gpu-board-webgl-four-chip-focus.png',
        { animations: 'disabled', timeout: 15_000 },
      );
    } finally {
      await style.evaluate((element) =>
        element.parentNode?.removeChild(element),
      );
    }
  }
});

test('boards and native controls fit 320 to 1440 pixels and enlarged text', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One project checks every responsive width.',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator('.gpu-card').evaluateAll((cards) => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      rects: cards.map((card) => card.getBoundingClientRect().toJSON()),
      controlsFit: cards.every((card) =>
        [...card.querySelectorAll('button')]
          .filter((button) => button.getClientRects().length > 0)
          .every((button) => {
            const r = button.getBoundingClientRect(),
              b = card.getBoundingClientRect();
            return (
              r.width >= 44 &&
              r.height >= 44 &&
              r.left >= b.left - 1 &&
              r.right <= b.right + 1
            );
          }),
      ),
    }));
    expect(geometry.overflow, `${width}px overflow`).toBeLessThanOrEqual(0);
    expect(geometry.controlsFit, `${width}px controls`).toBe(true);
    if (width >= 1024)
      expect(
        Math.abs(geometry.rects[0].top - geometry.rects[1].top),
      ).toBeLessThanOrEqual(1);
    else
      expect(geometry.rects[1].top).toBeGreaterThanOrEqual(
        geometry.rects[0].bottom,
      );
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await expect(
    page.getByRole('navigation', {
      name: 'Mobile workbench views',
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(async () => {
    document.documentElement.style.fontSize = '32px';
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const clipped = await page.locator('.gpu-card').evaluateAll((cards) =>
    cards
      .flatMap((card) => [
        ...card.querySelectorAll<HTMLElement>('button,.gpu-chip-summary'),
      ])
      .filter(
        (element) =>
          !element.closest('.sr-only') &&
          element.scrollWidth > element.clientWidth + 1,
      )
      .map((element) => element.textContent),
  );
  expect(clipped).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test('phone Interact and Done modes separate orbit and pinch gestures from ordinary page scrolling', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes('narrow'),
    'Both phone themes verify touch interaction modes.',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 2,
  });
  await openResources(page);
  await expect
    .poll(() => page.evaluate(() => matchMedia('(pointer: coarse)').matches))
    .toBe(true);
  const view = await readyBoard(page, 1),
    viewport = view.locator('.gpu-board-viewport');
  await expect(view).toHaveAttribute('data-interacting', 'false');
  await expect(viewport).toHaveCSS('touch-action', /^pan-y(?: pinch-zoom)?$/);
  const beforePan = await view.getAttribute('data-camera'),
    beforeScroll = await page.evaluate(() => scrollY);
  let bounds = (await viewport.boundingBox())!,
    x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 0 }],
  });
  for (let step = 1; step <= 5; step++)
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - step * 22, id: 0 }],
    });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect
    .poll(() => page.evaluate(() => scrollY))
    .toBeGreaterThan(beforeScroll + 30);
  await expect(view).toHaveAttribute('data-camera', beforePan!);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await view.scrollIntoViewIfNeeded();
  await view.getByRole('button', { name: 'Interact', exact: true }).click();
  await expect(view).toHaveAttribute('data-interacting', 'true');
  await expect(viewport).toHaveCSS('touch-action', 'none');
  const beforeOrbit = await view.getAttribute('data-camera');
  bounds = (await viewport.boundingBox())!;
  x = bounds.x + bounds.width / 2;
  y = bounds.y + bounds.height / 2;
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 0 }],
  });
  for (let step = 1; step <= 5; step++)
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + step * 9, y: y + step * 2, id: 0 }],
    });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(view).not.toHaveAttribute('data-camera', beforeOrbit!);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const beforePinch = JSON.parse((await view.getAttribute('data-camera'))!) as {
    distance: number;
  };
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: x - 28, y, id: 0 },
      { x: x + 28, y, id: 1 },
    ],
  });
  for (let step = 1; step <= 5; step++)
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - 28 - step * 5, y, id: 0 },
        { x: x + 28 + step * 5, y, id: 1 },
      ],
    });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect
    .poll(
      async () =>
        JSON.parse((await view.getAttribute('data-camera'))!).distance,
    )
    .toBeLessThan(beforePinch.distance);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await view.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(view).toHaveAttribute('data-interacting', 'false');
  await expect(viewport).toHaveCSS('touch-action', /^pan-y(?: pinch-zoom)?$/);
  await gpuCard(page, 1)
    .getByRole('button', {
      name: 'Open GPU 1 · GI 1 · CI 0 details',
      exact: true,
    })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('forced colors and context loss preserve inspection and restore the existing camera', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await openResources(page);
  await expect(board(page, 1)).toHaveAttribute('data-render-mode', 'fallback');
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).__gpuContexts.length,
    ),
  ).toBe(0);
  const button = gpuCard(page, 1).getByRole('button', {
    name: 'Open GPU 1 · GI 1 · CI 0 details',
    exact: true,
  });
  await button.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await closeDetail(page);
  await page.emulateMedia({ forcedColors: 'none' });
  const view = await readyBoard(page, 1);
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const camera = await view.getAttribute('data-camera');
  expect(
    await page
      .locator('canvas.gpu-board-canvas')
      .evaluate((canvas: HTMLCanvasElement) => {
        const extension = canvas
          .getContext('webgl2')
          ?.getExtension('WEBGL_lose_context');
        if (!extension) return false;
        (window as unknown as FixtureWindow).__gpuLostExtension = extension;
        extension.loseContext();
        return true;
      }),
  ).toBe(true);
  await expect(view).toHaveAttribute('data-render-mode', 'fallback');
  await button.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await closeDetail(page);
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).__gpuLostExtension!.restoreContext(),
  );
  await expect(view).toHaveAttribute('data-render-mode', 'webgl', {
    timeout: 20_000,
  });
  await expect(view).toHaveAttribute('data-camera', camera!);
});

test('GPU capacity opens all physical boards with assignment badges and complete sibling topology', async ({
  page,
}) => {
  await page.goto('/#overview');
  const capacity = page.getByRole('button', { name: 'Inspect GPU resources' });
  await expect(capacity.locator('.host-capacity-value')).toHaveText('2');
  await capacity.click();
  await expect(page.locator('.gpu-card')).toHaveCount(4);
  await expect(page.locator('.gpu-resource-filter')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^Unassigned ·/u }),
  ).toHaveCount(0);
  await expect(
    gpuCard(page, 0).locator('.gpu-full-chip-button .gpu-allocation-label'),
  ).toHaveText('Assigned');
  await expect(gpuCard(page, 1).locator('.gpu-ci-button')).toHaveCount(2);
  await expect(
    gpuCard(page, 1).locator(
      '.gpu-ci-button[data-allocation-state="reserved"]',
    ),
  ).toHaveCount(1);
  await expect(
    gpuCard(page, 1).locator(
      '.gpu-ci-button[data-allocation-state="reserved"] .gpu-allocation-label',
    ),
  ).toHaveText('Reserved');
  await expect(
    gpuCard(page, 1).locator(
      '.gpu-ci-button[data-allocation-state="unassigned"] .gpu-allocation-label',
    ),
  ).toHaveText('Unassigned');
  await readyBoard(page, 1);
  await expect(page.locator('.gpu-card')).toHaveCount(4);
});

test('stale assignments never become inferred free GPU capacity', async ({
  page,
}) => {
  const stale = structuredClone(snapshot);
  stale.attribution!.status = 'stale';
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: stale }),
  );
  await page.goto('/#overview');
  const capacity = page.getByRole('button', { name: 'Inspect GPU resources' });
  await expect(capacity.locator('.host-capacity-value')).toHaveText('—');
  await expect(capacity).toContainText('Unknown');
  await capacity.click();
  await expect(page.locator('.gpu-card')).toHaveCount(4);
  await expect(
    page.locator('.gpu-card [data-allocation-state="unassigned"]'),
  ).toHaveCount(0);
  await expect(page.locator('.gpu-ci-button .gpu-allocation-label')).toHaveText(
    ['Unknown', 'Unknown'],
  );
  await expect(
    gpuCard(page, 1).locator('.gpu-ci-button').first(),
  ).toHaveAccessibleDescription(/Assignment unknown/u);
});

test('wheel zoom belongs to the viewer with focused controls and leaves the neighboring camera unchanged', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  const first = await readyBoard(page, 0),
    second = await readyBoard(page, 1);
  const firstCamera = await first.getAttribute('data-camera');
  const control = second.getByRole('button', { name: 'Zoom in', exact: true });
  await page.keyboard.press('Tab');
  await control.focus();
  await expect(control).toBeFocused();
  const before = await second.getAttribute('data-camera'),
    rect = (await second.locator('.gpu-board-viewport').boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.wheel(0, -80);
  await expect(second).not.toHaveAttribute('data-camera', before!);
  await expect(first).toHaveAttribute('data-camera', firstCamera!);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

async function observeLastViewRemoval(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as FixtureWindow;
    state.__gpuCanvasHiddenOnRemoval = null;
    const observer = new MutationObserver(() => {
      if (document.querySelector('.hardware-board-view, .gpu-board-view'))
        return;
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas.gpu-board-canvas',
      );
      const style = canvas ? getComputedStyle(canvas) : null;
      state.__gpuCanvasHiddenOnRemoval =
        !canvas ||
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        style?.opacity === '0';
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

test('the shared canvas retains the motherboard after GPU removal and clears its final scene on navigation', async ({
  page,
}) => {
  const allocated = structuredClone(snapshot);
  allocated.attribution!.assignments.push(
    {
      workloadRef: 'workspace-refinement',
      entityType: 'physical_gpu',
      entityUuid: 'GPU-refinement-3',
      state: 'allocated',
    },
    {
      workloadRef: 'workspace-refinement',
      entityType: 'compute_instance',
      entityUuid: 'MIG-refinement-1',
      state: 'allocated',
    },
  );
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: allocated }),
  );
  await openResources(page);
  await readyBoard(page, 0);
  await observeLastViewRemoval(page);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).__gpuCanvasHiddenOnRemoval,
      ),
    )
    .toBe(true);
  await page.getByRole('link', { name: 'Resources', exact: true }).click();
  await readyBoard(page, 0);
  await observeLastViewRemoval(page);
  const empty = structuredClone(allocated);
  empty.sequence++;
  empty.gpus = [];
  await sendSnapshot(page, empty);
  await expect(page.locator('.gpu-board-view')).toHaveCount(0);
  await expect(
    page.locator('.motherboard-resources .hardware-board-view'),
  ).toHaveAttribute('data-render-mode', 'webgl');
  await expect(page.locator('canvas.gpu-board-canvas')).toHaveCount(1);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).__gpuCanvasHiddenOnRemoval,
      ),
    )
    .toBe(true);
});

test('pending graphics retain native chip geometry and allow the first touch activation', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-narrow-dark',
    'One 320px coarse-pointer case verifies the wrapping toolbar before graphics load.',
  );
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 2,
  });
  let releaseRenderer!: () => void;
  const pendingRenderer = new Promise<void>((resolve) => {
    releaseRenderer = resolve;
  });
  await page.route('**/gpu-board-renderer.ts*', async (route) => {
    await pendingRenderer;
    await route.continue();
  });
  try {
    await openResources(page);
    const card = gpuCard(page, 0),
      view = board(page, 0);
    await expect(view).toHaveAttribute('data-render-mode', 'loading');
    await expect(page.locator('.gpu-board-loading')).toHaveCount(0);
    const button = card.locator('.gpu-full-chip-button');
    await button.scrollIntoViewIfNeeded();
    const geometry = () =>
      card.evaluate((element) => {
        const cardBounds = element.getBoundingClientRect();
        return [
          ...element.querySelectorAll<HTMLElement>(
            '.gpu-board-viewport, .gpu-board-view button, .gpu-full-chip-button',
          ),
        ].map((control) => {
          const bounds = control.getBoundingClientRect();
          return {
            label: control.getAttribute('aria-label') ?? control.textContent,
            x: bounds.x - cardBounds.x,
            y: bounds.y - cardBounds.y,
            width: bounds.width,
            height: bounds.height,
          };
        });
      });
    const pendingGeometry = await geometry();
    const bounds = (await button.boundingBox())!;
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          id: 0,
        },
      ],
    });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect(page.getByRole('dialog')).toBeVisible();
    await closeDetail(page);
    await expect(button).toBeFocused();
    releaseRenderer();
    await expect(view).toHaveAttribute('data-render-mode', 'webgl', {
      timeout: 20_000,
    });
    expect(await geometry()).toEqual(pendingGeometry);
    await button.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
  } finally {
    releaseRenderer();
  }
});

test('SM activity controls actual chip emission while hover and focus preserve its intensity and camera', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const current = idleSnapshot();
  current.gpus[0].metrics.sm_activity.value = 10;
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: current }),
  );
  await openResources(page);
  const view = await readyBoard(page, 0);
  const key = current.gpus[0].uuid;
  await expect
    .poll(async () => (await chipAppearance(view, key)).activity)
    .toBe(10);
  const low = await chipAppearance(view, key);
  expect(low.activity).toBe(10);
  expect(low.particleCount).toBe(0);
  const camera = await view.getAttribute('data-camera');
  current.sequence++;
  current.gpus[0].metrics.sm_activity.value = 85;
  await sendSnapshot(page, current);
  await expect
    .poll(async () => (await chipAppearance(view, key)).activity)
    .toBe(85);
  const high = await chipAppearance(view, key);
  expect(high.emissiveIntensity).toBeGreaterThan(low.emissiveIntensity);
  await captureChipState(
    view,
    testInfo.outputPath('chip-active-85-percent.png'),
  );
  const button = gpuCard(page, 0).locator('.gpu-full-chip-button');
  await button.hover();
  await expect(view).toHaveAttribute('data-highlighted-chip', key);
  await expect
    .poll(async () => (await chipAppearance(view, key)).transitioning)
    .toBe(false);
  expect((await chipAppearance(view, key)).emissiveIntensity).toBeCloseTo(
    high.emissiveIntensity,
    8,
  );
  await page.keyboard.press('Tab');
  await button.focus();
  expect((await chipAppearance(view, key)).emissiveIntensity).toBeCloseTo(
    high.emissiveIntensity,
    8,
  );
  await expect(view).toHaveAttribute('data-camera', camera!);
  current.sequence++;
  current.gpus[0].metrics.sm_activity.value = 0;
  current.gpus[0].metrics.gpu_activity.value = 99;
  await sendSnapshot(page, current);
  await expect
    .poll(async () => (await chipAppearance(view, key)).activity)
    .toBe(0);
  const zero = await chipAppearance(view, key);
  expect(zero.emissiveIntensity).toBeLessThan(high.emissiveIntensity);
  expect(zero.particleCount).toBe(0);
  await expect(gpuCard(page, 0).locator('.gpu-chip-summary')).toContainText(
    '0.0%',
  );
  await button.blur();
  await page.mouse.move(0, 0);
  await expect(view).toHaveAttribute('data-highlighted-chip', '');
  await captureChipState(
    view,
    testInfo.outputPath('chip-idle-zero-percent.png'),
  );
  await expectNoWebGLDraws(page);
});

test('fresh positive activity animates only visible live chips and stops for zero stale reduced motion and hidden pages', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const current = idleSnapshot();
  current.gpus[0].metrics.sm_activity.value = 60;
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: current }),
  );
  await openResources(page);
  let view = await readyBoard(page, 0);
  const key = current.gpus[0].uuid;
  await expect
    .poll(async () => (await chipAppearance(view, key)).particleCount)
    .toBeGreaterThan(0);
  const phase = (await chipAppearance(view, key)).phase;
  await expect
    .poll(async () => (await chipAppearance(view, key)).phase)
    .toBeGreaterThan(phase);
  await page.waitForTimeout(350);
  const frameSample = () =>
    view.evaluate((element) => ({
      frame: Number(element.getAttribute('data-render-sequence')),
      time: performance.now(),
    }));
  const start = await frameSample();
  await page.waitForTimeout(650);
  const finish = await frameSample();
  expect(
    (finish.frame - start.frame) / ((finish.time - start.time) / 1000),
  ).toBeLessThanOrEqual(35);
  const camera = await view.getAttribute('data-camera');

  current.sequence++;
  current.gpus[0].metrics.sm_activity.value = 0;
  await sendSnapshot(page, current);
  await expect
    .poll(async () => (await chipAppearance(view, key)).activity)
    .toBe(0);
  await expect
    .poll(async () => (await chipAppearance(view, key)).particleCount)
    .toBe(0);
  await expectNoWebGLDraws(page);

  current.sequence++;
  current.gpus[0].metrics.sm_activity.value = 60;
  current.gpus[0].metrics.sm_activity.status = 'stale';
  await sendSnapshot(page, current);
  await expect
    .poll(async () => (await chipAppearance(view, key)).activity)
    .toBeNull();
  expect((await chipAppearance(view, key)).particleCount).toBe(0);
  await expectNoWebGLDraws(page);

  current.sequence++;
  current.gpus[0].metrics.sm_activity.status = 'available';
  await sendSnapshot(page, current);
  await expect
    .poll(async () => (await chipAppearance(view, key)).particleCount)
    .toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(async () => (await chipAppearance(view, key)).particleCount)
    .toBe(0);
  expect((await chipAppearance(view, key)).activity).toBe(60);
  await expectNoWebGLDraws(page);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect
    .poll(async () => (await chipAppearance(view, key)).particleCount)
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  try {
    await expectNoWebGLDraws(page);
  } finally {
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  const resume = (await chipAppearance(view, key)).phase;
  await expect
    .poll(async () => (await chipAppearance(view, key)).phase)
    .toBeGreaterThan(resume);
  // The motherboard provides a complete viewport above every GPU. The last
  // GPU row can be too short to scroll the first row fully out at page bottom.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  expect(
    await view
      .locator('.gpu-board-viewport')
      .evaluate((element) => element.getBoundingClientRect().top - innerHeight),
  ).toBeGreaterThanOrEqual(0);
  await expectNoWebGLDraws(page);
  view = await readyBoard(page, 0);
  const returned = (await chipAppearance(view, key)).phase;
  await expect
    .poll(async () => (await chipAppearance(view, key)).phase)
    .toBeGreaterThan(returned);
  await expect(view).toHaveAttribute('data-camera', camera!);

  await page.evaluate(() => {
    const state = window as unknown as FixtureWindow;
    state.__gpuHeartbeatPaused = true;
    const events = state.__gpuEvents as EventSource;
    events.onerror?.call(events, new Event('error'));
  });
  await expect
    .poll(async () => (await chipAppearance(view, key)).activity)
    .toBeNull();
  await expect
    .poll(async () => (await chipAppearance(view, key)).state)
    .toBe('unknown');
  expect((await chipAppearance(view, key)).particleCount).toBe(0);
  await expect(
    gpuCard(page, 0).locator('.gpu-full-chip-button .gpu-allocation-label'),
  ).toHaveText('Unknown');
  await expectNoWebGLDraws(page);
});

test('sibling CIs share GI activity while reservations and unknown assignments never animate as active resources', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const current = idleSnapshot();
  const gi = current.gpus[1].gpuInstances[0];
  gi.metrics.sm_activity.value = 38;
  const sibling = structuredClone(gi.computeInstances[0]);
  sibling.uuid = 'MIG-shared-activity-sibling';
  sibling.generation = `${sibling.uuid}@1`;
  sibling.id = 1;
  sibling.metrics.sm_activity = {
    ...gi.metrics.sm_activity,
    scope: 'compute_instance',
    value: 99,
  };
  gi.computeInstances.push(sibling);
  current.attribution!.assignments = current.attribution!.assignments.filter(
    (assignment) => assignment.entityUuid !== 'MIG-refinement-0',
  );
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: current }),
  );
  await openResources(page);
  const view = await readyBoard(page, 1);
  await expect
    .poll(async () => (await chipAppearance(view, 'MIG-refinement-0')).activity)
    .toBe(38);
  const first = await chipAppearance(view, 'MIG-refinement-0');
  const second = await chipAppearance(view, sibling.uuid);
  expect(first.activity).toBe(38);
  expect(second.activity).toBe(38);
  expect(first.emissiveIntensity).toBeCloseTo(second.emissiveIntensity, 8);
  for (const id of [0, 1]) {
    const control = gpuCard(page, 1).getByRole('button', {
      name: `Open GPU 1 · GI 0 · CI ${id} details`,
      exact: true,
    });
    await control.focus();
    const summary = gpuCard(page, 1).locator('.gpu-chip-summary');
    await expect(summary).toContainText('Shared GI 0 SM activity');
    await expect(summary).toContainText('38.0%');
    await expect(summary.getByText(/Shared GI \d+ memory/u)).toHaveCount(1);
  }
  current.sequence++;
  current.attribution!.assignments.push({
    workloadRef: 'workspace-refinement',
    entityType: 'compute_instance',
    entityUuid: 'MIG-refinement-0',
    state: 'reserved',
  });
  await sendSnapshot(page, current);
  await expect
    .poll(async () => (await chipAppearance(view, 'MIG-refinement-0')).state)
    .toBe('reserved');
  expect((await chipAppearance(view, 'MIG-refinement-0')).particleCount).toBe(
    0,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect
    .poll(async () => (await chipAppearance(view, sibling.uuid)).particleCount)
    .toBeGreaterThan(0);
  expect((await chipAppearance(view, 'MIG-refinement-0')).particleCount).toBe(
    0,
  );
  current.sequence++;
  current.attribution!.status = 'stale';
  await sendSnapshot(page, current);
  await expect
    .poll(async () => (await chipAppearance(view, sibling.uuid)).state)
    .toBe('unknown');
  expect((await chipAppearance(view, sibling.uuid)).particleCount).toBe(0);
  await expectNoWebGLDraws(page);
});

test('a silent stream expires activity and transport reopening cannot revive old telemetry', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One project verifies the wall-clock freshness deadline.',
  );
  const current = idleSnapshot();
  current.gpus[0].metrics.sm_activity.value = 60;
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: current }),
  );
  await openResources(page);
  const view = await readyBoard(page, 0);
  const key = current.gpus[0].uuid;
  await expect
    .poll(async () => (await chipAppearance(view, key)).particleCount)
    .toBeGreaterThan(0);
  const camera = await view.getAttribute('data-camera');
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).__gpuHeartbeatPaused = true;
  });
  await expect
    .poll(async () => (await chipAppearance(view, key)).activity, {
      timeout: 8000,
    })
    .toBeNull();
  await expect(
    gpuCard(page, 0).locator('.gpu-full-chip-button .gpu-allocation-label'),
  ).toHaveText('Unknown');
  await expectNoWebGLDraws(page);
  await page.evaluate(() => {
    const state = window as unknown as FixtureWindow;
    const events = state.__gpuEvents as EventSource;
    events.onopen?.call(events, new Event('open'));
    events.dispatchEvent(
      new MessageEvent('snapshot', {
        data: JSON.stringify(state.__gpuSnapshot),
      }),
    );
  });
  await expectNoWebGLDraws(page);
  expect((await chipAppearance(view, key)).activity).toBeNull();
  expect((await chipAppearance(view, key)).particleCount).toBe(0);
  await sendSnapshot(page, current);
  await expect
    .poll(async () => (await chipAppearance(view, key)).particleCount)
    .toBeGreaterThan(0);
  await expect(
    gpuCard(page, 0).locator('.gpu-full-chip-button .gpu-allocation-label'),
  ).toHaveText('Assigned');
  await expect(view).toHaveAttribute('data-camera', camera!);
});

async function expectCameraNear(view: Locator, expected: string) {
  const before = JSON.parse(expected) as Record<string, number>;
  await expect
    .poll(async () => {
      const after = JSON.parse(
        (await view.getAttribute('data-camera')) ?? '{}',
      ) as Record<string, number>;
      return Object.entries(before).every(
        ([key, value]) => Math.abs(after[key] - value) < 1e-8,
      );
    })
    .toBe(true);
}

async function readyMotherboard(page: Page) {
  const view = page.locator('.motherboard-resources .hardware-board-view');
  await view.scrollIntoViewIfNeeded();
  await expect(view).toHaveAttribute('data-render-mode', 'webgl');
  await expect(view).toHaveAttribute('data-camera', /distance/u);
  return view;
}

test('keyboard focus frames remain above zoomed motherboard and GPU geometry', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  for (const kind of ['motherboard', 'gpu']) {
    const view =
      kind === 'motherboard'
        ? await readyMotherboard(page)
        : await readyBoard(page, 1);
    if (kind === 'motherboard') {
      await view.getByRole('button', { name: 'Focus selected' }).click();
    }
    await enableInteraction(view);
    await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const viewport = view.locator('.hardware-board-viewport');
    await viewport.press('ArrowRight');
    await expect(viewport).toBeFocused();
    const screenshot = await viewport.screenshot({
      animations: 'disabled',
      scale: 'css',
    });
    // Inspect the composited pixels: DOM styles alone cannot detect a shared
    // WebGL canvas painting over the focus ring in a different stacking layer.
    const pixels = await viewport.evaluate(async (element, png) => {
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      const style = getComputedStyle(element);
      context.fillStyle =
        style.getPropertyValue('--gpu-accent').trim() ||
        style.getPropertyValue('--ring').trim();
      context.fillRect(0, 0, 1, 1);
      const expected = [...context.getImageData(0, 0, 1, 1).data];
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const edges: number[][] = [];
      for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const x = Math.floor(canvas.width * fraction);
        const y = Math.floor(canvas.height * fraction);
        for (const [px, py] of [
          [x, 2],
          [x, canvas.height - 3],
          [2, y],
          [canvas.width - 3, y],
        ]) {
          edges.push([...context.getImageData(px, py, 1, 1).data]);
        }
      }
      return { expected, edges };
    }, screenshot.toString('base64'));
    for (const pixel of pixels.edges) {
      expect(
        pixel.every(
          (channel, i) => Math.abs(channel - pixels.expected[i]) <= 3,
        ),
        `${kind} focus frame pixel ${pixel.join(', ')} should match ${pixels.expected.join(', ')}`,
      ).toBe(true);
    }
    await expect(viewport).toHaveScreenshot(`${kind}-foreground-focus.png`, {
      animations: 'disabled',
    });
  }
});

test('motherboard keeps all host facts visible and links selection without moving its camera', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  const view = await readyMotherboard(page);
  const camera = (await view.getAttribute('data-camera'))!;
  for (const id of ['cpu', 'memory', 'storage']) {
    await expect(page.locator(`#resource-${id}`)).toBeVisible();
  }
  await expect(page.locator('#resource-cpu')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.locator('#resource-memory').click();
  await expect(page.locator('#resource-memory')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectCameraNear(view, camera);
  await view.scrollIntoViewIfNeeded();
  await view
    .getByRole('button', { name: 'Focus selected', exact: true })
    .click();
  await expect(view).toHaveAttribute('data-focus', 'memory');
  await expect(view).not.toHaveAttribute('data-camera', camera);
  const selectedCamera = (await view.getAttribute('data-camera'))!;
  const gpu = await readyBoard(page, 0);
  const gpuCamera = (await gpu.getAttribute('data-camera'))!;
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.getByRole('link', { name: 'Resources', exact: true }).click();
  await readyMotherboard(page);
  const restoredMotherboard = JSON.parse(
    (await view.getAttribute('data-camera'))!,
  );
  for (const [key, value] of Object.entries(
    JSON.parse(selectedCamera) as Record<string, number>,
  )) {
    expect(restoredMotherboard[key]).toBeCloseTo(value, 8);
  }
  await expect(page.locator('#resource-memory')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await readyBoard(page, 0);
  const restoredGPU = JSON.parse((await gpu.getAttribute('data-camera'))!);
  for (const [key, value] of Object.entries(
    JSON.parse(gpuCamera) as Record<string, number>,
  )) {
    expect(restoredGPU[key]).toBeCloseTo(value, 8);
  }
  await expect(page.locator('canvas.gpu-board-canvas')).toHaveCount(1);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page
    .getByRole('button', { name: 'Inspect Storage resources', exact: true })
    .click();
  await expect(page.locator('#resource-storage')).toBeFocused();
  await expect(page.locator('#resource-storage')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('motherboard glow reflects measured CPU and memory occupancy while unavailable stays neutral', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  const view = await readyMotherboard(page);
  const initialCamera = (await view.getAttribute('data-camera'))!;
  const intensities: number[] = [];
  for (const value of [0, 50, 100]) {
    const next = idleSnapshot();
    next.system.cpu.utilization.value = value;
    next.system.memory.utilization.value = value;
    await sendSnapshot(page, next);
    await expect
      .poll(async () => {
        const activity = JSON.parse(
          (await view.getAttribute('data-activity')) ?? '[]',
        ) as ChipAppearance[];
        return activity.filter(
          ({ id, activity }) =>
            ['cpu', 'memory'].includes(id) && activity === value,
        ).length;
      })
      .toBe(2);
    const appearance = await chipAppearance(view, 'cpu');
    expect(appearance.emissiveIntensity).toBeCloseTo(
      0.15 + (0.65 * value) / 100,
      4,
    );
    intensities.push(appearance.emissiveIntensity);
    await expectCameraNear(view, initialCamera);
    await expect(view).toHaveScreenshot(
      `motherboard-utilization-${value}.png`,
      { animations: 'disabled', maxDiffPixelRatio: 0.002 },
    );
  }
  expect(intensities[0]).toBeLessThan(intensities[1]);
  expect(intensities[1]).toBeLessThan(intensities[2]);
  const estimated = idleSnapshot();
  estimated.system.memory.status = 'estimated';
  estimated.system.cpu.utilization.status = 'error';
  await sendSnapshot(page, estimated);
  await expect
    .poll(async () => (await chipAppearance(view, 'memory')).activity)
    .toBeNull();
  await expect
    .poll(async () => (await chipAppearance(view, 'cpu')).activity)
    .toBeNull();
  await expect(page.locator('.motherboard-resources')).toContainText(
    'Estimated',
  );
  const violations = (
    await new AxeBuilder({ page }).include('.motherboard-resources').analyze()
  ).violations;
  expect(violations, `${testInfo.project.name} accessibility`).toEqual([]);
});

test('motherboard picking follows rotation and zoom and ignores drag gestures', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  const view = await readyMotherboard(page);
  await enableInteraction(view);
  const viewport = view.locator('.hardware-board-viewport');
  await viewport.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await view.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const target = await projectedChip(view, 'memory');
  const rect = (await viewport.boundingBox())!;
  await page.mouse.click(rect.x + target.x, rect.y + target.y);
  await expect(page.locator('#resource-memory')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await view.scrollIntoViewIfNeeded();
  const cpu = await projectedChip(view, 'cpu');
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + cpu.x, box.y + cpu.y);
  await page.mouse.down();
  await page.mouse.move(box.x + cpu.x + 35, box.y + cpu.y + 15, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#resource-memory')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('motherboard stays readable from 320 to 1440 pixels and preserves fallback inspection', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes('narrow'),
    'Desktop projects exercise all widths in both themes.',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openResources(page);
  await readyMotherboard(page);
  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page
      .locator('.motherboard-resources')
      .evaluate((panel) => {
        const viewport = panel
          .querySelector('.hardware-board-viewport')!
          .getBoundingClientRect();
        const cpu = panel
          .querySelector('#resource-cpu')!
          .getBoundingClientRect();
        return {
          height: viewport.height,
          viewport: viewport.toJSON(),
          cpu: cpu.toJSON(),
          overflow: document.documentElement.scrollWidth - innerWidth,
          controls: [...panel.querySelectorAll('button')]
            .filter((button) => button.getClientRects().length)
            .every((button) => {
              const r = button.getBoundingClientRect();
              return r.width >= 44 && r.height >= 44;
            }),
        };
      });
    expect(geometry.overflow, `${width}px overflow`).toBeLessThanOrEqual(0);
    expect(geometry.controls, `${width}px controls`).toBe(true);
    expect(geometry.height).toBe(
      width >= 1024 ? 460 : width >= 640 ? 360 : 280,
    );
    if (width >= 1024)
      expect(geometry.cpu.left).toBeGreaterThan(geometry.viewport.right);
    else
      expect(geometry.cpu.top).toBeGreaterThanOrEqual(geometry.viewport.bottom);
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await page.emulateMedia({ forcedColors: 'active' });
  const view = page.locator('.motherboard-resources .hardware-board-view');
  await expect(view).toHaveAttribute('data-render-mode', 'fallback');
  await page.locator('#resource-storage').click();
  await expect(page.locator('#resource-storage')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.motherboard-resources svg')).not.toHaveCount(0);
});

test('dynamic MIG verification updates capacity badges glow and details without rebuilding the board', async ({
  page,
}) => {
  const current = structuredClone(snapshot);
  current.attribution!.assignments = current.attribution!.assignments.filter(
    (a) => a.entityType === 'physical_gpu',
  );
  current.attribution!.resolution = {
    status: 'incomplete',
    unresolvedAssignments: 2,
    reasonCodes: ['preparation_pending'],
    workloads: [
      {
        workloadRef: 'workspace-refinement',
        unresolvedAssignments: 2,
        reasonCodes: ['preparation_pending'],
      },
    ],
  };
  await page.route('**/api/v1/snapshot', (route) =>
    route.fulfill({ json: current }),
  );
  await page.goto('/#overview');
  const capacity = page.getByRole('button', { name: 'Inspect GPU resources' });
  await expect(capacity.locator('.host-capacity-value')).toHaveText('—');
  await capacity.click();
  const view = await readyBoard(page, 1);
  const card = gpuCard(page, 1);
  await expect(card.locator('.gpu-ci-button .gpu-allocation-label')).toHaveText(
    ['Unknown', 'Unknown'],
  );
  expect((await chipAppearance(view, 'MIG-refinement-0')).state).toBe(
    'unknown',
  );
  const control = card.getByRole('button', {
    name: 'Open GPU 1 · GI 0 · CI 0 details',
    exact: true,
  });
  await control.focus();
  await control.evaluate(
    (el) => ((window as unknown as FixtureWindow).__gpuOriginalCI = el),
  );
  current.sequence++;
  current.attribution!.resolution = {
    status: 'complete',
    unresolvedAssignments: 0,
    reasonCodes: [],
    workloads: [],
  };
  for (const uuid of ['MIG-refinement-0', 'MIG-refinement-1'])
    current.attribution!.assignments.push({
      workloadRef: 'workspace-refinement',
      entityType: 'compute_instance',
      entityUuid: uuid,
      state: 'allocated',
    });
  await sendSnapshot(page, current);
  await expect(card.locator('.gpu-ci-button .gpu-allocation-label')).toHaveText(
    ['Assigned', 'Assigned'],
  );
  await expect
    .poll(async () => (await chipAppearance(view, 'MIG-refinement-0')).state)
    .toBe('assigned');
  expect(
    await control.evaluate(
      (el) => el === (window as unknown as FixtureWindow).__gpuOriginalCI,
    ),
  ).toBe(true);
  await expect(control).toBeFocused();
  await control.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('fixture-owner');
  await page.keyboard.press('Escape');
  await expect(control).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as FixtureWindow).__gpuContexts.length,
    ),
  ).toBe(1);
});
