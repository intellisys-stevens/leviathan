import AxeBuilder from '@axe-core/playwright';
import {
  configureDashboardTests,
  expect,
  test,
  gpuUUID,
  secondGPUUUID,
  secondGIUUID,
  secondCIUUID,
  snapshot,
  alignedRequestCount,
  selectWorkloadOwner,
  moveCommands,
} from './fixtures/dashboard';

configureDashboardTests({ cpuCompositing: true });

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
    {
      timeout: 20_000,
    },
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

test.describe('loads canonical hashes as direct top-level views', () => {
  for (const view of ['Overview', 'Resources', 'Workloads', 'Status']) {
    test(view, async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name !== 'chromium-desktop-dark',
        'One desktop project covers canonical direct entry.',
      );
      // Enter from another document so each case tests initial routing rather
      // than queuing transitions from the preceding view.
      await page.goto('about:blank');
      await page.goto(`/#${view.toLowerCase()}`);
      await expect(
        page.getByRole('heading', { name: view, exact: true, level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: view, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    });
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
    // Software-rendered Linux can delay mounting or the scroll-position probe.
    await expect(destination).toBeVisible({ timeout: 15_000 });
    await expect(destination).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 15_000 })
      .toBe(0);
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

test('opens native full GPU and MIG chip controls', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One pointer-capable project covers native GPU chip controls.',
  );
  await page.getByRole('link', { name: 'Resources' }).click();

  const gpuCards = page.locator('.gpu-card');
  await expect(gpuCards).toHaveCount(2);
  await expect(gpuCards.first()).toHaveClass(/snow-capped/u);

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
  await expect(page.getByTestId('detail-sheet')).toBeHidden();
});

test('opens Workloads details through resource whitespace', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One pointer-capable project covers stretched resource surfaces.',
  );
  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const button = page
    .getByRole('button', { name: /^Open GPU \d+ · Full GPU details$/u })
    .first();
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
  expect(Math.abs(buttonBox!.height - surfaceBox!.height)).toBeLessThanOrEqual(
    2.1,
  );
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
});

test('removes a closed detail sheet when its exit animation stalls', async ({
  page,
}) => {
  // Reloading and opening two WebGL scenes can consume the ordinary test
  // budget under software graphics. The fallback itself stays clock-bounded.
  test.setTimeout(120_000);
  await page.clock.install();
  await page.reload();
  await page.getByRole('link', { name: 'Resources' }).click();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const detail = page.getByTestId('detail-sheet');
  await expect(detail).toBeVisible({ timeout: 20_000 });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10_000));
  await detail.evaluate(() => {
    const getAnimations = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'getAnimations',
    )?.value as Element['getAnimations'];
    if (typeof getAnimations !== 'function')
      throw new Error('Browser animation inspection is unavailable');
    // Keep the probe attached if the popup is replaced. The ending-style
    // attribute is set before Base UI inspects the closing popup's animations.
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: function (
        this: Element,
        ...args: Parameters<Element['getAnimations']>
      ) {
        if (!this.matches('[data-testid="detail-sheet"][data-ending-style]'))
          return getAnimations.apply(this, args);
        const diagnosticWindow = window as Window & {
          __stalledSheetCloseQueries?: number;
        };
        diagnosticWindow.__stalledSheetCloseQueries =
          (diagnosticWindow.__stalledSheetCloseQueries ?? 0) + 1;
        return [{ finished: new Promise<Animation>(() => undefined) }];
      },
    });
  });
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __stalledSheetCloseQueries?: number })
          .__stalledSheetCloseQueries ?? 0,
    ),
  ).toBe(0);
  // Advance the animation frame before the fallback timer. A busy software
  // renderer can otherwise remove the sheet before the stall probe runs.
  await detail.getByRole('button', { name: 'Close' }).click({ force: true });
  await page.clock.runFor(100);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __stalledSheetCloseQueries?: number })
            .__stalledSheetCloseQueries ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect(detail).toHaveCount(1);
  await page.clock.fastForward(1_500);
  await expect(detail).toHaveCount(0, { timeout: 5_000 });
  await page.clock.resume();

  await page
    .getByRole('button', {
      name: 'Open GPU 1 · GI 0 · CI 0 details',
      exact: true,
    })
    .click();
  await expect(detail).toBeVisible();
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
  await expect(page.locator('.workbench-view')).toHaveCSS('opacity', '1');
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
