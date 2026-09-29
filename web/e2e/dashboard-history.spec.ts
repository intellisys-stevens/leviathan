import type { Locator } from '@playwright/test';
import {
  configureDashboardTests,
  expect,
  test,
  sampledAt,
  gpuUUID,
  snapshot,
  overviewChartIDs,
  alignedRequestCount,
  selectWorkloadOwner,
  moveCommands,
} from './fixtures/dashboard';

configureDashboardTests({ cpuCompositing: true });

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
    // Live chart updates can remount the tooltip between locator resolution
    // and evaluation, so resolve and measure the current node in one task.
    const geometry = await page.evaluate((tooltipTestId) => {
      const element = document.querySelector<HTMLElement>(
        `[data-testid="${tooltipTestId}"]`,
      )!;
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
    }, tooltipTestId);
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

test('switches workbench views without reloading retained charts', async ({
  page,
}) => {
  test.setTimeout(120_000);
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
});

test('resource detail history is inspectable directly by keyboard', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Resources' }).click();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  const detail = page.getByTestId('detail-sheet');
  const detailPlot = detail.locator('figure').first();
  // Wait for the lazy panel and chart before testing keyboard interaction.
  await expect(detailPlot.locator('.recharts-wrapper')).toBeVisible({
    timeout: 20_000,
  });
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
