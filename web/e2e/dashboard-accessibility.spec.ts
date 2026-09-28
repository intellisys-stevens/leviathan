import AxeBuilder from '@axe-core/playwright';
import {
  configureDashboardTests,
  expect,
  test,
  settings,
  waitForOverviewCharts,
  overviewChartIDs,
  alignedRequestCount,
  selectWorkloadOwner,
} from './fixtures/dashboard';

configureDashboardTests();

for (const view of ['Overview', 'Resources', 'Workloads', 'Status']) {
  test(`${view} has no serious or critical authored accessibility violations`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('link', { name: view }).click();
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      ({ impact }) => impact === 'serious' || impact === 'critical',
    );
    expect(
      blocking,
      `${view}: ${blocking.map(({ id }) => id).join(', ')}`,
    ).toEqual([]);
  });
}

test('Resource detail has no serious or critical authored accessibility violations', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('link', { name: 'Resources' }).click();
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  );
  expect(
    blocking,
    `Resource detail: ${blocking.map(({ id }) => id).join(', ')}`,
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('detail-sheet')).toBeHidden();
});

test('covers required responsive widths with a concise header', async ({
  page,
}, testInfo) => {
  // Allow the full responsive interaction matrix without changing per-action timeouts.
  test.setTimeout(150_000);
  test.skip(
    !testInfo.project.name.includes('desktop'),
    'Desktop projects exercise every required width in both themes.',
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('link', { name: 'Workloads' }).click();
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
    await expect(page.getByRole('link', { name: 'Workloads' })).toHaveAttribute(
      'aria-current',
      'page',
    );
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
        header.getByRole('button', { name: /Use (light|dark) theme/ }),
      ).toBeVisible();
      await expect(
        header.getByRole('link', {
          name: 'Open Leviathan repository on GitHub',
        }),
      ).toBeVisible();
      await expect(page.getByTestId('process-card')).toHaveCount(0);
      await expect(page.getByTestId('process-scroll-viewport')).toHaveCount(0);
      await page.evaluate(
        (nextSettings) => {
          const source = (
            window as unknown as {
              __leviathanEventSource: {
                dispatchEvent: (event: Event) => boolean;
                onerror: ((event: Event) => void) | null;
                onopen: ((event: Event) => void) | null;
              };
            }
          ).__leviathanEventSource;
          source.dispatchEvent(
            new MessageEvent('settings', {
              data: JSON.stringify(nextSettings),
            }),
          );
          source.onopen?.(new Event('open'));
          source.onerror?.(new Event('error'));
        },
        { ...settings, samplingIntervalMs: 500 },
      );
      await expect(
        page.getByRole('button', {
          name: 'Reconnecting status, view updates 0.5s',
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
      await expect(page.getByTestId('process-scroll-viewport')).toHaveCount(0);
      await expect(page.getByTestId('process-card')).toHaveCount(0);
    }

    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(
      page
        .getByRole('region', { name: 'Host capacity' })
        .locator(':scope > [data-slot="snow-cap"]'),
    ).toHaveCount(0);

    await page.getByRole('link', { name: 'Resources' }).click();
    await expect(
      page.getByRole('heading', { name: 'Resources', exact: true, level: 1 }),
    ).toBeFocused({ timeout: 20_000 });
    await expect(page.locator('.gpu-full-chip-button')).toHaveCount(1);
    await expect(page.locator('.gpu-ci-button')).toHaveCount(1);
    const gpuControlFit = await page
      .locator('.gpu-instance-controls')
      .evaluateAll((groups) =>
        groups.every((group) => group.scrollWidth <= group.clientWidth + 1),
      );
    expect(gpuControlFit).toBe(true);
    await page.locator('.gpu-ci-button').focus();
    await expect(page.locator('.gpu-chip-summary')).toContainText(
      'Shared GI 0 memory',
    );

    await page
      .getByRole('button', { name: 'Open GPU 0 full GPU details' })
      .click();
    const detail = page.getByTestId('detail-sheet');
    await expect(detail).toBeVisible({ timeout: 20_000 });
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
      expect(detailGeometry.columns).toBe(width < 640 ? 2 : 4);
      expect(detailGeometry.chartHeight).toBeCloseTo(176, 0);
    } else {
      expect(detailGeometry.width).toBeCloseTo(
        Math.min(Math.max(640, width * 0.68), 880, width - 32),
        0,
      );
      expect(detailGeometry.columns).toBe(width >= 1024 ? 5 : 4);
      expect(detailGeometry.chartHeight).toBeCloseTo(192, 0);
    }
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    // Keyboard activation skips Playwright's click-navigation wait on this hash route.
    await page.getByRole('link', { name: 'Workloads' }).focus();
    await page.keyboard.press('Enter');
    const workloads = page.getByTestId('people-view');
    await expect(page).toHaveURL(/#workloads$/u);
    await expect(workloads).toBeVisible();
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
    await expect(
      page.getByRole('heading', { name: 'Telemetry', level: 4 }),
    ).toBeVisible();
    await expect(workloads).not.toContainText(
      'Device-scoped signals, not user usage.',
    );
    await expect(page.locator('.workload-telemetry-chart')).toHaveCount(7);
    const telemetryColumns = await workloads
      .locator('.workload-telemetry-grid')
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(' ').length,
      );
    expect(telemetryColumns).toBe(width >= 1024 ? 2 : 1);
    await expect(workloads).not.toContainText('Parent GI metrics');
    await expect(workloads).not.toContainText('Physical GPU metrics');
    await expect(workloads.getByText('Allocated', { exact: true })).toHaveCount(
      1,
    );
    await expect(workloads.getByText('Reserved', { exact: true })).toHaveCount(
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
      await expect(mobileFooter).toContainText('Leviathan v0.4.0');
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
        'Built with ⚔️ by Intellisys Dragoons and Codex · Leviathan v0.4.0',
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
  await expect(page.locator('.host-capacity-card')).toHaveCount(4);

  await expect.poll(() => alignedRequestCount(page)).toBe(7);
  for (const chartID of overviewChartIDs) {
    const chart = page.getByTestId(chartID);
    const legend = chart.locator('.mobile-chart-legend');
    const legendItems = legend.locator('.mobile-chart-legend-item');
    const seriesCount = Number(await legend.getAttribute('data-series-count'));
    await expect(legendItems).toHaveCount(seriesCount);
    await expect(
      chart.locator('.overview-series path.recharts-line-curve'),
    ).toHaveCount(seriesCount);
    const readableControls = await legend.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.right <= window.innerWidth &&
        [...element.querySelectorAll('button')].every((button) => {
          const control = button.getBoundingClientRect();
          return control.width <= bounds.width + 1 && control.height >= 44;
        })
      );
    });
    expect(readableControls).toBe(true);
  }

  await mobileNavigation.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Resources', level: 1 }),
  ).toBeFocused();
  const resourceGeometry = await page
    .locator('.gpu-card')
    .first()
    .evaluate((element) => ({
      controlsHeight: element
        .querySelector('.gpu-instance-controls')!
        .getBoundingClientRect().height,
      surfaceMinHeight: getComputedStyle(
        element.querySelector('.gpu-full-chip-button')!,
      ).minHeight,
      width: element.getBoundingClientRect().width,
    }));
  expect(resourceGeometry.controlsHeight).toBeGreaterThanOrEqual(44);
  expect(resourceGeometry.controlsHeight).toBeLessThanOrEqual(80);
  expect(
    Number.parseFloat(resourceGeometry.surfaceMinHeight),
  ).toBeLessThanOrEqual(144);
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

  for (const view of ['Workloads', 'Status', 'Overview']) {
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

test('whole-machine phone controls contain reconnecting text and health actions', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes('desktop'),
    'Desktop projects cover both themes at each extra phone width.',
  );
  for (const width of [390, 430, 640, 767]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(() => {
      const source = (
        window as unknown as {
          __leviathanEventSource: { onerror?: (event: Event) => void };
        }
      ).__leviathanEventSource;
      source.onerror?.(new Event('error'));
    });
    const trigger = page.locator('.mobile-status-trigger');
    await expect(trigger).toBeVisible();
    const fits = await trigger.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        fit: element.scrollWidth <= element.clientWidth,
        inside: bounds.right <= innerWidth,
      };
    });
    expect(fits.width).toBeGreaterThanOrEqual(44);
    expect(fits.height).toBeGreaterThanOrEqual(44);
    expect(fits.fit).toBe(true);
    expect(fits.inside).toBe(true);
    const ribbon = page.getByRole('region', { name: 'Active host health' });
    const button = ribbon.getByRole('button', { name: 'Status' });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await trigger.click();
    await expect(
      page.getByRole('dialog').getByText('synthetic-host'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test.describe('whole-machine layouts retain readable controls at 200 percent text size', () => {
  for (const width of [320, 360]) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });
      for (const view of ['Overview', 'Resources', 'Workloads', 'Status']) {
        test(view, async ({ page }, testInfo) => {
          test.skip(
            !testInfo.project.name.includes('desktop'),
            'Both desktop projects exercise enlarged text at phone widths.',
          );
          test.setTimeout(60_000);
          await page.goto(`/#${view.toLowerCase()}`);
          await expect(
            page.getByRole('heading', { name: view, level: 1 }),
          ).toBeVisible();
          if (view === 'Overview') {
            await waitForOverviewCharts(page);
            await expect(page.locator('.recharts-wrapper')).toHaveCount(9);
          }
          if (view === 'Resources') {
            const board = page.locator('.gpu-board-view').first();
            await board.scrollIntoViewIfNeeded();
            await expect(board).toHaveAttribute('data-render-mode', 'webgl', {
              timeout: 20_000,
            });
          }
          if (view === 'Workloads') {
            await selectWorkloadOwner(page, 'synthetic-owner');
            await expect(page.locator('.workload-telemetry-chart')).toHaveCount(
              7,
            );
            // This legacy fixture has GPU readings but no owner cgroup measurements.
            await expect(
              page.locator('.workload-telemetry-chart .recharts-wrapper'),
            ).toHaveCount(4);
          }
          if (view === 'Status') {
            await expect(page.locator('.health-day')).toHaveCount(270);
          }
          const navigation = page.getByRole('navigation', {
            name: 'Mobile workbench views',
          });
          await expect(navigation).toBeVisible();
          await page.evaluate(async () => {
            await document.fonts.ready;
            // Enlarge text only: changing layout rem units would mask cramped controls.
            const fonts = [
              ...document.body.querySelectorAll<HTMLElement | SVGElement>('*'),
            ].map(
              (element) =>
                [
                  element,
                  parseFloat(getComputedStyle(element).fontSize),
                ] as const,
            );
            for (const [element, size] of fonts) {
              element.style?.setProperty(
                'font-size',
                `${size * 2}px`,
                'important',
              );
            }
          });
          await expect
            .poll(
              () =>
                page.evaluate(
                  () => document.documentElement.scrollWidth - innerWidth,
                ),
              {
                message: `${view} at ${width}px must fit with 200% text`,
              },
            )
            .toBeLessThanOrEqual(0);
          const links = await navigation
            .getByRole('link')
            .evaluateAll((elements) =>
              elements.map((element) => {
                const bounds = element.getBoundingClientRect();
                const walker = document.createTreeWalker(
                  element,
                  NodeFilter.SHOW_TEXT,
                );
                const textBounds: DOMRect[] = [];
                for (
                  let node = walker.nextNode();
                  node;
                  node = walker.nextNode()
                ) {
                  if (!node.textContent?.trim()) continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  textBounds.push(range.getBoundingClientRect());
                }
                return {
                  inside: bounds.left >= 0 && bounds.right <= innerWidth,
                  // Decorative perimeter light extends 2px beyond the control.
                  readable: textBounds.every(
                    (text) =>
                      text.left >= bounds.left && text.right <= bounds.right,
                  ),
                  height: bounds.height,
                };
              }),
            );
          expect(links).toHaveLength(4);
          for (const link of links) {
            expect(link.inside).toBe(true);
            expect(link.readable).toBe(true);
            expect(link.height).toBeGreaterThanOrEqual(44);
          }
          // Perimeter light extends past the control; visible text must still fit.
          const clipped = await page
            .locator(
              '.host-capacity-card, .assignment-status, [data-testid="process-card"] dl, .health-history-heading',
            )
            .evaluateAll((elements) =>
              elements.flatMap((element) => {
                const bounds = element.getBoundingClientRect();
                const walker = document.createTreeWalker(
                  element,
                  NodeFilter.SHOW_TEXT,
                );
                const clippedText: string[] = [];
                for (
                  let node = walker.nextNode();
                  node;
                  node = walker.nextNode()
                ) {
                  if (
                    !node.textContent?.trim() ||
                    node.parentElement?.closest('.sr-only')
                  ) {
                    continue;
                  }
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  if (
                    [...range.getClientRects()].some(
                      (text) =>
                        text.width > 0 &&
                        (text.left < bounds.left || text.right > bounds.right),
                    )
                  ) {
                    clippedText.push(node.textContent.trim());
                  }
                }
                return clippedText.length
                  ? [{ control: element.getAttribute('class'), clippedText }]
                  : [];
              }),
            );
          expect(
            clipped,
            `${view} controls must contain enlarged text`,
          ).toEqual([]);
          // Tick labels must stay inside the SVG even when the plot becomes narrower.
          await expect
            .poll(
              () =>
                page
                  .locator('.recharts-cartesian-axis-tick text')
                  .evaluateAll((elements) =>
                    elements
                      .filter((element) => {
                        const bounds = element.getBoundingClientRect();
                        const svg = element
                          .closest('svg')
                          ?.getBoundingClientRect();
                        return (
                          svg &&
                          bounds.width > 0 &&
                          (bounds.left < svg.left - 1 ||
                            bounds.right > svg.right + 1 ||
                            bounds.top < svg.top - 1 ||
                            bounds.bottom > svg.bottom + 1)
                        );
                      })
                      .map((element) => element.textContent),
                  ),
              {
                message: `${view} chart labels must fit at ${width}px`,
              },
            )
            .toEqual([]);
        });
      }
    });
  }
});

test('aligns compact capacity rows and exposes direct mobile actions', async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes('desktop'),
    'Both themes cover every width.',
  );
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.fonts.ready);
  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const cards = page.locator('.host-capacity-card');
    await expect(cards).toHaveCount(4);
    const geometry = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        const slots = [
          '.host-capacity-label',
          '.host-capacity-value',
          '.host-capacity-unit',
          '.host-capacity-detail',
          '[data-slot="progress-track"], .gpu-allocation-bar',
        ];
        return {
          top: box.top,
          height: box.height,
          left: box.left,
          right: box.right,
          rows: slots.map(
            (selector) =>
              element.querySelector(selector)!.getBoundingClientRect().top,
          ),
          barHeight: element.querySelector(slots[4])!.getBoundingClientRect()
            .height,
          bottomInset:
            box.bottom -
            element.querySelector(slots[4])!.getBoundingClientRect().bottom,
        };
      }),
    );
    for (const card of geometry) {
      expect(card.left).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(width);
      expect(card.barHeight).toBe(4);
      expect(card.bottomInset).toBeLessThanOrEqual(17);
      for (const sibling of geometry.filter(
        (other) => Math.abs(other.top - card.top) < 1,
      )) {
        expect(card.height).toBeCloseTo(sibling.height, 0);
        card.rows.forEach((top, index) =>
          expect(top).toBeCloseTo(sibling.rows[index], 0),
        );
      }
    }
    await expect(
      page.locator('.host-capacity-footnote, .gpu-allocation-legend'),
    ).toHaveCount(0);
    await expect(cards.locator('[data-gpu-brand]')).toHaveCount(0);
    await expect(cards.locator('.lucide-gauge')).toHaveCount(1);
    const header = page.getByRole('banner');
    await expect(
      header.getByRole('button', { name: 'Open app menu' }),
    ).toHaveCount(0);
    for (const control of [
      header.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
      header.getByRole('button', { name: /Use (light|dark) theme/ }),
    ]) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    if (width < 768) {
      await header
        .getByRole('button', { name: /Live status, view updates/ })
        .click();
      const popup = page.getByRole('dialog');
      await expect(popup).toBeVisible();
      await expect(popup).not.toContainText(
        /This browser updates|Host samples|profiles|processes/,
      );
      await expect(popup.getByText('synthetic-host')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(
        header.getByRole('button', { name: /Live status, view updates/ }),
      ).toBeFocused();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await expect(
    page.getByTestId('gpu-activity-chart').locator('.lucide-gauge'),
  ).toHaveCount(1);
});
