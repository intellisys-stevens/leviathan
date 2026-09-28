import {
  configureDashboardTests,
  expect,
  test,
  selectWorkloadOwner,
} from './fixtures/dashboard';

configureDashboardTests();

test('changes only browser display cadence with compact accessible status', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const settingsPatches: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname === '/api/v1/settings'
    )
      settingsPatches.push(request.postData() ?? '');
  });
  await page.evaluate(() =>
    localStorage.setItem('leviathan.displayCadence.v1', '2000'),
  );
  await page.reload();
  const header = page.getByRole('banner');
  const desktop = page.getByTestId('desktop-live-sampling');
  const mobile = page.getByTestId('mobile-live-sampling');
  if (page.viewportSize()!.width >= 768) {
    await expect(desktop).toBeVisible();
    await expect(mobile).toBeHidden();
    await expect(desktop.getByText('Live', { exact: true })).toBeVisible();
    const choices = desktop.getByRole('radiogroup', { name: 'View updates' });
    await expect(choices.getByRole('radio', { name: '2s' })).toBeChecked();
    for (const [label, value] of [
      ['1s', '1000'],
      ['0.5s', '500'],
      ['2s', '2000'],
    ]) {
      await choices.getByText(label, { exact: true }).click();
      await expect(choices.getByRole('radio', { name: label })).toBeChecked();
      expect(
        await page.evaluate(() =>
          localStorage.getItem('leviathan.displayCadence.v1'),
        ),
      ).toBe(value);
    }
    expect((await desktop.boundingBox())!.width).toBeLessThan(240);
  } else {
    await expect(desktop).toBeHidden();
    const trigger = mobile.getByRole('button', {
      name: 'Live status, view updates 2s',
    });
    await expect(trigger).toHaveText('Live · 2s');
    for (const control of [
      trigger,
      header.getByRole('button', { name: /Use (light|dark) theme/ }),
      header.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await trigger.click();
    const popup = page.getByRole('dialog');
    await expect(popup).toBeVisible();
    await expect(popup.getByText('synthetic-host')).toBeVisible();
    const choices = popup.getByRole('radiogroup', { name: 'View updates' });
    await expect(
      choices.getByRole('radio', { name: '2s', exact: true }),
    ).toBeChecked();
    for (const [label, value] of [
      ['1s', '1000'],
      ['0.5s', '500'],
      ['2s', '2000'],
    ]) {
      await choices.getByText(label, { exact: true }).click();
      await expect(
        choices.getByRole('radio', { name: label, exact: true }),
      ).toBeChecked();
      expect(
        await page.evaluate(() =>
          localStorage.getItem('leviathan.displayCadence.v1'),
        ),
      ).toBe(value);
    }
    await expect(popup).not.toContainText(
      /This browser updates|Host samples|profiles|processes/,
    );
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await page.reload();
  if (page.viewportSize()!.width >= 768) {
    await expect(desktop.getByRole('radio', { name: '2s' })).toBeChecked();
    await expect(desktop.getByText('Live', { exact: true })).toBeVisible();
  } else {
    await expect(
      mobile.getByRole('button', { name: 'Live status, view updates 2s' }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(
      async () =>
        (await (await fetch('/api/v1/settings')).json()).samplingIntervalMs,
    ),
  ).toBe(500);
  await expect(header).toHaveScreenshot('view-cadence-header.png', {
    animations: 'disabled',
    timeout: 20_000,
  });
  expect(settingsPatches).toEqual([]);
});

test('matches targeted workbench and frost-dragon visual baselines', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('gpu-activity-chart')).toBeVisible();
  await expect(
    page.getByTestId('host-storage-chart').locator('.recharts-wrapper'),
  ).toBeVisible();
  const project = testInfo.project.name;
  const capturePage = async (name: string) => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page).toHaveScreenshot(name, {
      animations: 'disabled',
      timeout: 30_000,
      fullPage: true,
      maxDiffPixelRatio: 0.002,
    });
  };
  const captureViewport = (name: string) =>
    expect(page).toHaveScreenshot(name, {
      animations: 'disabled',
      timeout: 20_000,
      fullPage: false,
      maxDiffPixels: 32,
    });
  const showAllocatedWorkloads = async () => {
    await page.getByRole('link', { name: 'Workloads' }).click();
    await selectWorkloadOwner(page, 'synthetic-owner');
    await expect(page.locator('.workload-telemetry-chart')).toHaveCount(7);
    await expect(
      page.locator('.workload-telemetry-chart .recharts-wrapper').first(),
    ).toBeVisible();
  };
  const openFullGPUDetail = async () => {
    await selectWorkloadOwner(page, 'synthetic-owner');
    await page
      .getByRole('button', {
        name: /^Open GPU \d+ · Full GPU details$/u,
      })
      .click();
    const detail = page.getByTestId('detail-sheet');
    await expect(detail).toBeVisible();
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBe(0);
  };
  const closeDetail = async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('detail-sheet')).toBeHidden();
  };

  if (project === 'chromium-desktop-dark') {
    await capturePage('overview-dark.png');
    const tooltipChart = page
      .getByTestId('memory-chart')
      .locator('.recharts-wrapper')
      .first();
    await tooltipChart.scrollIntoViewIfNeeded();
    const tooltipChartBox = await tooltipChart.boundingBox();
    expect(tooltipChartBox).not.toBeNull();
    await page.mouse.move(
      tooltipChartBox!.x + tooltipChartBox!.width - 24,
      tooltipChartBox!.y + tooltipChartBox!.height / 2,
    );
    await expect(page.getByTestId('memory-chart-tooltip')).toBeVisible();
    await captureViewport('chart-tooltip-dark.png');
    await page.mouse.move(0, 0);
    await page.getByRole('link', { name: 'Resources' }).click();
    await page.addStyleTag({
      content: `
        .dark .flowing-surface:hover:not(:focus-within)
          > .perimeter-light .perimeter-light-glow {
          animation: none !important;
          opacity: 0.82 !important;
        }
      `,
    });
    const hoveredResource = page
      .getByRole('button', { name: 'Open GPU 0 full GPU details' })
      .locator('xpath=..');
    await hoveredResource.hover();
    await expect(hoveredResource).toHaveScreenshot(
      'resources-hover-border-dark.png',
      { animations: 'disabled' },
    );
    await page.mouse.move(0, 0);
    // A shared scroll-attached canvas renders visible scenes; capture the viewport
    // instead of stitching unrendered offscreen boards into a full-page image.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(page.locator('.gpu-board-view').first()).toHaveAttribute(
      'data-render-mode',
      'webgl',
    );
    await captureViewport('resources-desktop.png');
    await page
      .getByRole('region', { name: 'GPUs', exact: true })
      .evaluate(async (element) => {
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
    await expect(page.locator('.gpu-board-view').nth(1)).toHaveAttribute(
      'data-render-mode',
      'webgl',
    );
    await captureViewport('gpu-resources-desktop.png');
    await showAllocatedWorkloads();
    const hoveredWorkload = page
      .getByRole('button', {
        name: /^Open GPU \d+ · Full GPU details$/u,
      })
      .locator('xpath=..');
    await hoveredWorkload.hover();
    await captureViewport('workloads-resource-hover-dark.png');
    await page.mouse.move(0, 0);
    await capturePage('workloads-desktop-dark.png');
    await openFullGPUDetail();
    await captureViewport('detail-desktop-dark.png');
    await closeDetail();
  }
  if (project === 'chromium-desktop-light') {
    await capturePage('overview-frost-light.png');
    await showAllocatedWorkloads();
    await capturePage('workloads-desktop-light.png');
    await openFullGPUDetail();
    await captureViewport('detail-desktop-light.png');
    await closeDetail();
  }
  if (
    project === 'chromium-narrow-dark' ||
    project === 'chromium-narrow-light'
  ) {
    const theme = project.endsWith('light') ? 'light' : 'dark';
    await capturePage(`overview-mobile-${theme}.png`);
    await page.getByRole('link', { name: 'Resources' }).click();
    await captureViewport(`resources-narrow-${theme}.png`);
    const aboutMotherboard = page.getByLabel(
      'About this motherboard illustration',
    );
    await aboutMotherboard.click();
    await expect(page.locator('.motherboard-resources')).toHaveCSS(
      'isolation',
      'auto',
    );
    await expect(page.locator('.motherboard-resources')).toHaveCSS(
      'backdrop-filter',
      'none',
    );
    await expect(page.locator('.motherboard-about')).toHaveAttribute(
      'open',
      '',
    );
    await page.mouse.move(0, 0);
    await captureViewport(`resources-about-narrow-${theme}.png`);
    await aboutMotherboard.click();
    const isolatedBoardStyle = await page.addStyleTag({
      content:
        '.mobile-workbench-nav, .leviathan-header { visibility: hidden }',
    });
    try {
      await page.mouse.move(0, 0);
      await page.locator('.gpu-card').first().scrollIntoViewIfNeeded();
      await expect(page.locator('.gpu-board-view').first()).toHaveAttribute(
        'data-render-mode',
        'webgl',
      );
      await expect(page.locator('.gpu-card').first()).toHaveScreenshot(
        `gpu-board-mobile-${theme}.png`,
        { animations: 'disabled' },
      );
      await page.locator('.gpu-card').nth(1).scrollIntoViewIfNeeded();
      await expect(page.locator('.gpu-board-view').nth(1)).toHaveAttribute(
        'data-render-mode',
        'webgl',
      );
      await expect(page.locator('.gpu-card').nth(1)).toHaveScreenshot(
        `mig-board-mobile-${theme}.png`,
        { animations: 'disabled' },
      );
    } finally {
      await isolatedBoardStyle.evaluate((element) =>
        element.parentNode?.removeChild(element),
      );
    }
    await showAllocatedWorkloads();
    await captureViewport(`workloads-mobile-${theme}.png`);
    await openFullGPUDetail();
    await captureViewport(`detail-mobile-${theme}.png`);
    await closeDetail();
  }
  await page.getByRole('link', { name: 'Status' }).click();
  await expect(page.locator('.health-day')).toHaveCount(270);
  await capturePage(
    `diagnostics-${project.includes('narrow') ? 'mobile' : 'desktop'}-${project.endsWith('light') ? 'light' : 'dark'}.png`,
  );
  if (project.endsWith('desktop-dark') || project.endsWith('desktop-light')) {
    // Isolate branding from compositor state left by the GPU inspection journey.
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Status', exact: true, level: 1 }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId('leviathan-header-mark')).toHaveScreenshot(
      `frost-dragon-${project.endsWith('light') ? 'light' : 'dark'}.png`,
      { animations: 'disabled', maxDiffPixels: 1 },
    );
  }
});
