import type { Locator } from '@playwright/test';
import {
  configureDashboardTests,
  expect,
  test,
  snapshot,
  selectWorkloadOwner,
  canvasFrameSignature,
  canvasFramesAreStable,
} from './fixtures/dashboard';

configureDashboardTests();

test('renders frost-dragon branding with glass, aurora, and ambient snow layers', async ({
  page,
}, testInfo) => {
  const light = testInfo.project.name.endsWith('-light');
  const root = page.locator('html');
  if (light) await expect(root).not.toHaveClass(/\bdark\b/u);
  else await expect(root).toHaveClass(/\bdark\b/u);

  await expect(page.getByText('Leviathan', { exact: true })).toBeVisible();
  await expect(page.getByText('MIGLens', { exact: true })).toHaveCount(0);
  if (page.viewportSize()!.width < 768) {
    await expect(
      page.getByRole('button', { name: 'Open app menu' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: light ? 'Use dark theme' : 'Use light theme',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
  } else {
    await expect(
      page.getByRole('link', { name: 'Open Leviathan repository on GitHub' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/intellisys-stevens/leviathan',
    );
  }
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    '/leviathan-mark.svg',
  );
  const markResponse = await page.request.get('/leviathan-mark.svg');
  expect(markResponse.status()).toBe(200);
  expect(markResponse.headers()['content-type']).toContain('image/svg+xml');
  expect(await markResponse.text()).toContain(
    '<title id="title">Leviathan frost-dragon mark</title>',
  );
  const headerMark = page.getByTestId('leviathan-header-mark');
  await expect(headerMark).toBeVisible();
  const expectedMarkSize = page.viewportSize()!.width < 768 ? 32 : 40;
  expect(await headerMark.boundingBox()).toMatchObject({
    width: expectedMarkSize,
    height: expectedMarkSize,
  });
  const ambientSnow = page.getByTestId('ambient-snow');
  await expect(ambientSnow).toHaveAttribute('aria-hidden', 'true');
  await expect(ambientSnow).toHaveJSProperty('tagName', 'CANVAS');
  await expect(
    page
      .getByRole('region', { name: 'Host capacity' })
      .locator(':scope > [data-slot="snow-cap"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Host capacity' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'CPU', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'RAM', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Storage', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.getByRole('heading', { name: 'Storage', exact: true }),
  ).toBeVisible();
  const storageResources = page.getByRole('region', {
    name: 'Storage',
    exact: true,
  });
  await expect(
    storageResources.getByRole('heading', { name: '/', exact: true }),
  ).toBeVisible();
  await expect(
    storageResources.getByText('ext4', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.gpu-card').first()).toBeVisible();

  const visual = await page.evaluate(() => {
    const cardElement = document.querySelector('.frost-panel')!;
    const card = getComputedStyle(cardElement);
    const cardRail = getComputedStyle(cardElement, '::before');
    const header = getComputedStyle(document.querySelector('header')!);
    const shell = document.querySelector('.app-shell')!;
    const auroraPrimary = getComputedStyle(shell, '::before');
    const auroraSecondary = getComputedStyle(shell, '::after');
    const ambientSnow = document.querySelector<HTMLCanvasElement>(
      '[data-testid="ambient-snow"]',
    )!;
    const snowStyle = getComputedStyle(ambientSnow);
    const snowCapElement = document.querySelector<HTMLElement>('.snow-cap')!;
    const snowCap = getComputedStyle(snowCapElement);
    const snowCapBody = getComputedStyle(
      snowCapElement.querySelector<HTMLElement>('.snow-cap-body')!,
    );
    const snowCapShadow = getComputedStyle(
      snowCapElement.querySelector<SVGElement>('.snow-cap-shadow')!,
    );
    const snowCapHighlight = getComputedStyle(
      snowCapElement.querySelector<SVGElement>('.snow-cap-highlight')!,
    );
    const root = getComputedStyle(document.documentElement);
    return {
      auroraPrimary: auroraPrimary.backgroundImage,
      auroraSecondary: auroraSecondary.backgroundImage,
      auroraPrimaryAnimation: auroraPrimary.animationName,
      auroraSecondaryAnimation: auroraSecondary.animationName,
      ambientSnowDisplay: snowStyle.display,
      ambientSnowPointerEvents: snowStyle.pointerEvents,
      ambientSnowPosition: snowStyle.position,
      ambientSnowZIndex: snowStyle.zIndex,
      ambientSnowOverflow: snowStyle.overflow,
      ambientSnowState: ambientSnow.dataset.state,
      snowCapDisplay: snowCap.display,
      snowCapPointerEvents: snowCap.pointerEvents,
      snowCapZIndex: snowCap.zIndex,
      snowCapProfile: snowCapElement.dataset.snowProfile,
      snowCapPiles: Number(snowCapElement.dataset.snowPiles),
      snowCapBodyFill: snowCapBody.fill,
      snowCapShadowFill: snowCapShadow.fill,
      snowCapHighlightStroke: snowCapHighlight.stroke,
      snowCapAnimation: snowCapBody.animationName,
      snowCapFilter: snowCap.filter,
      cardRail: cardRail.backgroundImage,
      cardRadius: Number.parseFloat(card.borderRadius),
      cardBackdrop: card.backdropFilter,
      headerBackdrop: header.backdropFilter,
      headerBorder: Number.parseFloat(header.borderBottomWidth),
      glassPanelToken: root.getPropertyValue('--glass-panel').trim(),
      auroraToken: root.getPropertyValue('--aurora').trim(),
      storedTheme: localStorage.getItem('leviathan.theme.v1'),
      legacyKeys: Object.keys(localStorage).filter((key) =>
        key.startsWith('miglens.'),
      ),
    };
  });
  expect(visual.auroraPrimary).not.toBe('none');
  expect(visual.auroraSecondary).not.toBe('none');
  expect(visual.auroraPrimaryAnimation).toBe('aurora-clockwise');
  expect(visual.auroraSecondaryAnimation).toBe('aurora-counterclockwise');
  expect(visual.ambientSnowDisplay).toBe(light ? 'none' : 'block');
  expect(visual.ambientSnowPointerEvents).toBe('none');
  expect(visual.ambientSnowPosition).toBe('fixed');
  expect(visual.ambientSnowZIndex).toBe('-1');
  expect(visual.ambientSnowOverflow).toBe('clip');
  expect(visual.ambientSnowState).toBe(light ? 'hidden' : 'running');
  expect(visual.snowCapDisplay).toBe(light ? 'none' : 'block');
  expect(visual.snowCapPointerEvents).toBe('none');
  expect(visual.snowCapZIndex).toBe('6');
  expect(visual.snowCapProfile).toBe('generated');
  expect(visual.snowCapPiles).toBeGreaterThanOrEqual(1);
  expect(visual.snowCapPiles).toBeLessThanOrEqual(2);
  if (!light) {
    expect(visual.snowCapBodyFill).not.toBe('none');
    expect(visual.snowCapShadowFill).not.toBe('none');
    expect(visual.snowCapHighlightStroke).not.toBe('none');
  }
  expect(visual.snowCapAnimation).toBe('none');
  expect(visual.snowCapFilter).toBe('none');
  expect(visual.cardRail).not.toBe('none');
  expect(visual.cardRadius).toBe(10);
  // The motherboard keeps HTML focus overlays above the shared WebGL canvas.
  expect(visual.cardBackdrop).toBe('none');
  expect(visual.headerBackdrop).toContain('blur');
  expect(visual.headerBorder).toBeGreaterThanOrEqual(1);
  expect(visual.glassPanelToken).not.toBe('');
  expect(visual.auroraToken).not.toBe('');
  expect(visual.storedTheme).toBe(light ? 'light' : 'dark');
  expect(visual.legacyKeys).toEqual([]);
});

test('animates, pauses, resumes, and theme-gates the ambient snow canvas', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark desktop project verifies the live canvas lifecycle.',
  );
  const canvas = page.getByTestId('ambient-snow');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect
    .poll(() => canvasFrameSignature(canvas), {
      intervals: [80, 120, 180, 250],
      timeout: 6_000,
    })
    .not.toBe('worker:0');

  const firstFrame = await canvasFrameSignature(canvas);
  await expect
    .poll(() => canvasFrameSignature(canvas), {
      intervals: [80, 120, 180, 250],
      timeout: 6_000,
    })
    .not.toBe(firstFrame);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  await expect.poll(() => canvasFramesAreStable(canvas)).toBe(true);

  const pausedFrame = await canvasFrameSignature(canvas);
  await page.evaluate(() => {
    delete (document as unknown as Record<string, unknown>).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect
    .poll(() => canvasFrameSignature(canvas), {
      intervals: [80, 120, 180, 250],
      timeout: 6_000,
    })
    .not.toBe(pausedFrame);

  await page
    .getByRole('button', { name: 'Use light theme' })
    .dispatchEvent('click');
  await expect(canvas).toBeHidden();
  await expect(canvas).toHaveAttribute('data-state', 'hidden');
  await page
    .getByRole('button', { name: 'Use dark theme' })
    .dispatchEvent('click');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-state', 'running');
});

test('renders denser mobile dot snow in the offscreen worker', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark Chromium project measures the canvas renderer.',
  );

  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 800,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Overview', exact: true, level: 1 }),
  ).toBeVisible();

  const canvas = page.getByTestId('ambient-snow');
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect(canvas).toHaveAttribute('data-renderer', 'worker');
  await expect(canvas).toHaveAttribute('data-particle-count', '60');
  await expect(canvas).toHaveAttribute('data-effective-dpr', '1.25');
  await expect
    .poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width))
    .toBe(400);
  await expect
    .poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).height))
    .toBe(1_000);

  const firstSequence = Number(
    await canvas.getAttribute('data-frame-sequence'),
  );
  await expect
    .poll(
      async () => Number(await canvas.getAttribute('data-frame-sequence')),
      { timeout: 3_000 },
    )
    .toBeGreaterThan(firstSequence);
  await session.send('Emulation.clearDeviceMetricsOverride');
});

test('keeps the ambient snow backing store viewport-sized and DPR-capped', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark project verifies the full responsive canvas range.',
  );
  const canvas = page.getByTestId('ambient-snow');

  for (const width of [320, 360, 390, 430, 640, 767, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    const readMetrics = () =>
      canvas.evaluate((element) => {
        const snow = element as HTMLCanvasElement;
        const bounds = snow.getBoundingClientRect();
        const cappedDPR = Number(snow.dataset.effectiveDpr);
        return {
          backingHeight: snow.height,
          backingWidth: snow.width,
          cappedDPR,
          cssHeight: bounds.height,
          cssWidth: bounds.width,
          left: bounds.left,
          top: bounds.top,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          particleCount: Number(snow.dataset.particleCount),
        };
      });

    const coarse = width < 768;
    // The worker publishes particle metadata separately from its canvas resize.
    // Wait for one complete observation of the requested viewport state.
    await expect(async () => {
      const metrics = await readMetrics();
      expect(
        Math.abs(
          metrics.backingWidth -
            Math.round(metrics.cssWidth * metrics.cappedDPR),
        ) <= 1 &&
          Math.abs(
            metrics.backingHeight -
              Math.round(metrics.cssHeight * metrics.cappedDPR),
          ) <= 1,
      ).toBe(true);
      expect(metrics.left).toBeCloseTo(0, 1);
      expect(metrics.top).toBeCloseTo(0, 1);
      expect(metrics.cssWidth).toBeCloseTo(metrics.viewportWidth, 0);
      expect(metrics.cssHeight).toBeCloseTo(metrics.viewportHeight, 0);
      expect(metrics.backingWidth / metrics.cssWidth).toBeLessThanOrEqual(1.26);
      expect(metrics.backingHeight / metrics.cssHeight).toBeLessThanOrEqual(
        1.26,
      );
      expect(metrics.particleCount).toBeGreaterThanOrEqual(coarse ? 60 : 120);
      expect(metrics.particleCount).toBeLessThanOrEqual(coarse ? 100 : 220);
    }).toPass({ timeout: 5_000 });
  }

  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 600,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const snow = element as HTMLCanvasElement;
        return {
          dpr: window.devicePixelRatio,
          height: snow.height,
          width: snow.width,
        };
      }),
    )
    .toEqual({ dpr: 2, height: 750, width: 1_000 });
  await session.send('Emulation.clearDeviceMetricsOverride');
});

test('keeps GPU view layout stationary on keyboard focus and Workloads glow inside its perimeter', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes('narrow'),
    'Desktop themes verify view geometry and Workloads hover effects.',
  );
  await page.getByRole('link', { name: 'Resources' }).click();
  const gpuButton = page.getByRole('button', {
    name: 'Open GPU 0 full GPU details',
  });
  const gpuView = page.locator('.gpu-card').first().locator('.gpu-board-view');
  await expect(gpuView).toBeVisible();
  await gpuView.scrollIntoViewIfNeeded();
  const documentBounds = () =>
    gpuView.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + scrollX,
        y: rect.y + scrollY,
        width: rect.width,
        height: rect.height,
      };
    });
  const before = await documentBounds();
  await page.keyboard.press('Tab');
  await gpuButton.focus();
  await expect(gpuButton).toBeFocused();
  await expect(gpuView).toHaveAttribute(
    'data-highlighted-chip',
    (await gpuButton.getAttribute('data-chip-key'))!,
  );
  const after = await documentBounds();
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(after[key] - before[key])).toBeLessThanOrEqual(1);

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const button = page.getByRole('button', {
    name: /^Open GPU \d+ · Full GPU details$/u,
  });
  const surface = button.locator('xpath=..');
  await surface.hover();
  await expect
    .poll(() =>
      surface.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .toContain(
      testInfo.project.name.endsWith('-dark')
        ? '0px 0px 52px'
        : '0px 20px 52px',
    );
  if (testInfo.project.name.endsWith('-dark')) {
    const mask = surface.locator(':scope > [data-slot="perimeter-light"]');
    const glow = mask.locator('[data-slot="perimeter-light-glow"]');
    await expect(mask).toHaveCSS('opacity', '1');
    await expect(mask).toHaveCSS('pointer-events', 'none');
    await expect(mask).toHaveCSS('overflow', 'hidden');

    const readPhase = () =>
      surface.evaluate((element) => {
        const mask = element.querySelector<HTMLElement>(
          ':scope > [data-slot="perimeter-light"]',
        )!;
        const glow = mask.querySelector<HTMLElement>(
          '[data-slot="perimeter-light-glow"]',
        )!;
        const hostRect = element.getBoundingClientRect();
        const maskRect = mask.getBoundingClientRect();
        const hostStyle = getComputedStyle(element);
        const maskStyle = getComputedStyle(mask);
        const glowStyle = getComputedStyle(glow);
        return {
          host: {
            left: hostRect.left,
            top: hostRect.top,
            right: hostRect.right,
            bottom: hostRect.bottom,
          },
          mask: {
            left: maskRect.left,
            top: maskRect.top,
            right: maskRect.right,
            bottom: maskRect.bottom,
          },
          hostTransform: hostStyle.transform,
          maskTransform: maskStyle.transform,
          maskAnimation: maskStyle.animationName,
          hostRadius: hostStyle.borderRadius,
          maskRadius: maskStyle.borderRadius,
          maskImage: maskStyle.maskImage,
          glowTransform: glowStyle.transform,
          glowAnimation: glowStyle.animationName,
          glowBackground: glowStyle.backgroundImage,
          glowOpacity: Number.parseFloat(glowStyle.opacity),
          animatedProperties: glow
            .getAnimations()
            .flatMap((animation) =>
              animation.effect instanceof KeyframeEffect
                ? animation.effect.getKeyframes()
                : [],
            )
            .flatMap((keyframe) => Object.keys(keyframe))
            .filter(
              (property) =>
                !['offset', 'computedOffset', 'easing', 'composite'].includes(
                  property,
                ),
            ),
        };
      });

    const phases = [await readPhase()];
    for (let phase = 0; phase < 2; phase += 1) {
      await page.waitForTimeout(320);
      phases.push(await readPhase());
    }
    for (const phase of phases) {
      expect(phase.maskTransform).toBe('none');
      expect(phase.maskAnimation).toBe('none');
      expect(phase.glowAnimation).toBe('perimeter-light-breathe');
      expect(phase.glowBackground).toContain('linear-gradient');
      expect(new Set(phase.animatedProperties)).toEqual(new Set(['opacity']));
      expect(phase.maskImage).toContain('linear-gradient');
      expect(phase.maskRadius).toBe(phase.hostRadius);
      expect(Math.abs(phase.host.left - phase.mask.left)).toBeLessThanOrEqual(
        2.1,
      );
      expect(Math.abs(phase.host.top - phase.mask.top)).toBeLessThanOrEqual(
        2.1,
      );
      expect(Math.abs(phase.mask.right - phase.host.right)).toBeLessThanOrEqual(
        2.1,
      );
      expect(
        Math.abs(phase.mask.bottom - phase.host.bottom),
      ).toBeLessThanOrEqual(2.1);
    }
    expect(new Set(phases.map((phase) => phase.glowTransform)).size).toBe(1);
    const glowOpacities = phases.map((phase) => phase.glowOpacity);
    expect(
      Math.max(...glowOpacities) - Math.min(...glowOpacities),
    ).toBeGreaterThan(0.03);
    expect(new Set(phases.map((phase) => phase.hostTransform)).size).toBe(1);
    expect(
      await glow.evaluate((element) => element.getAttribute('style')),
    ).toBe(null);
    expect(
      await surface.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit?.closest('[data-slot="perimeter-light"]') === null;
      }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
  } else {
    await expect(
      surface.locator(':scope > [data-slot="perimeter-light"]'),
    ).toHaveCSS('display', 'none');
  }

  await page.mouse.move(0, 0);
  await button.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(button).toBeFocused();
  await expect
    .poll(() =>
      surface.evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.outlineWidth} ${style.outlineStyle}`;
      }),
    )
    .toBe('2px solid');
  if (testInfo.project.name.endsWith('-dark')) {
    const focusedMask = surface.locator(
      ':scope > [data-slot="perimeter-light"]',
    );
    await expect(focusedMask).toHaveCSS('opacity', '1');
    await expect(
      focusedMask.locator('[data-slot="perimeter-light-glow"]'),
    ).toHaveCSS('animation-name', 'none');
  }

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const workloadSurface = page
    .getByRole('button', {
      name: /^Open GPU \d+ · Full GPU details$/u,
    })
    .locator('xpath=..');
  await workloadSurface.hover();
  await expect
    .poll(() =>
      workloadSurface.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      ),
    )
    .toContain(
      testInfo.project.name.endsWith('-dark')
        ? '0px 0px 52px'
        : '0px 20px 52px',
    );
  await expect(page.locator('.workload-person-detail')).toHaveCSS(
    'overflow',
    'visible',
  );
  await expect(workloadSurface.locator('xpath=../..')).toHaveCSS(
    'overflow',
    'visible',
  );
  await expect(workloadSurface.locator('xpath=../../..')).toHaveCSS(
    'overflow',
    'visible',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test('keeps Overview snow-free and card snow static above hover surfaces', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark fine-pointer project covers foreground snow compositing.',
  );

  await expect(
    page
      .getByRole('region', { name: 'Host capacity' })
      .locator(':scope > [data-slot="snow-cap"]'),
  ).toHaveCount(0);

  await page.getByRole('link', { name: 'Resources' }).click();
  const card = page.locator('.gpu-card').first();
  const cap = card.locator(':scope > [data-slot="snow-cap"]');
  const body = cap.locator('[data-slot="snow-cap-body"]');
  const shadow = cap.locator('[data-slot="snow-cap-shadow"]');
  const highlight = cap.locator('[data-slot="snow-cap-highlight"]');
  const resource = card.locator('.gpu-full-chip-button');

  await expect(cap).toHaveCount(1);
  await expect(cap).toBeVisible();
  await resource.hover();

  const readPhase = () =>
    card.evaluate((element) => {
      const cap = element.querySelector<HTMLElement>(
        ':scope > [data-slot="snow-cap"]',
      )!;
      const body = cap.querySelector<SVGElement>(
        '[data-slot="snow-cap-body"]',
      )!;
      const shadow = cap.querySelector<SVGElement>(
        '[data-slot="snow-cap-shadow"]',
      )!;
      const highlight = cap.querySelector<SVGElement>(
        '[data-slot="snow-cap-highlight"]',
      )!;
      const resource = element.querySelector<HTMLElement>(
        '.gpu-full-chip-button',
      )!;
      const cardRect = element.getBoundingClientRect();
      const chassisRect = cardRect;
      const capRect = cap.getBoundingClientRect();
      const hit = document.elementFromPoint(
        capRect.left + capRect.width / 2,
        capRect.top + capRect.height / 2,
      );
      return {
        cardRect: {
          top: cardRect.top,
          width: cardRect.width,
        },
        chassisRect: {
          left: chassisRect.left,
          right: chassisRect.right,
          width: chassisRect.width,
        },
        capRect: {
          left: capRect.left,
          top: capRect.top,
          right: capRect.right,
          bottom: capRect.bottom,
          width: capRect.width,
          height: capRect.height,
        },
        borderAlignment: Math.abs(
          capRect.top +
            (capRect.height * 15) / 24 -
            chassisRect.top -
            Number.parseFloat(getComputedStyle(element).borderTopWidth),
        ),
        capZIndex: Number.parseInt(getComputedStyle(cap).zIndex, 10),
        resourceZIndex:
          Number.parseInt(getComputedStyle(resource).zIndex, 10) || 0,
        capPointerEvents: getComputedStyle(cap).pointerEvents,
        capAnimation: getComputedStyle(cap).animationName,
        capFilter: getComputedStyle(cap).filter,
        bodyAnimation: getComputedStyle(body).animationName,
        shadowAnimation: getComputedStyle(shadow).animationName,
        highlightAnimation: getComputedStyle(highlight).animationName,
        bodyPaths: body.querySelectorAll('path').length,
        shadowPaths: shadow.querySelectorAll('path').length,
        highlightPaths: highlight.querySelectorAll('path').length,
        hitSnow: hit?.closest('[data-slot="snow-cap"]') != null,
      };
    });

  const phases = [await readPhase()];
  for (let phase = 0; phase < 2; phase += 1) {
    await page.waitForTimeout(320);
    phases.push(await readPhase());
  }
  for (const phase of phases) {
    expect(phase.capZIndex).toBeGreaterThan(phase.resourceZIndex);
    expect(phase.capPointerEvents).toBe('none');
    expect(phase.capAnimation).toBe('none');
    expect(phase.capFilter).toBe('none');
    expect(phase.bodyAnimation).toBe('none');
    expect(phase.shadowAnimation).toBe('none');
    expect(phase.highlightAnimation).toBe('none');
    expect(phase.bodyPaths).toBeGreaterThanOrEqual(1);
    expect(phase.bodyPaths).toBeLessThanOrEqual(2);
    expect(phase.shadowPaths).toBe(phase.bodyPaths);
    expect(phase.highlightPaths).toBeGreaterThan(0);
    expect(phase.hitSnow).toBe(false);
    expect(phase.capRect.top).toBeLessThan(phase.cardRect.top);
    expect(phase.capRect.bottom).toBeLessThanOrEqual(phase.cardRect.top + 20);
    expect(
      phase.capRect.width / phase.chassisRect.width,
    ).toBeGreaterThanOrEqual(0.8);
    expect(phase.capRect.left).toBeGreaterThanOrEqual(phase.chassisRect.left);
    expect(phase.capRect.right).toBeLessThanOrEqual(
      phase.chassisRect.right + 1,
    );
    expect(phase.capRect.height).toBeGreaterThanOrEqual(10);
    expect(phase.borderAlignment).toBeLessThanOrEqual(0.5);
  }
  expect(
    new Set(phases.map(({ capRect }) => JSON.stringify(capRect))).size,
  ).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(body).toHaveCSS('animation-name', 'none');
  await expect(shadow).toHaveCSS('animation-name', 'none');
  await expect(highlight).toHaveCSS('animation-name', 'none');
});

test('keeps every flowing treatment rounded and pointer transparent', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark fine-pointer project covers all perimeter consumers.',
  );

  const assertRoundedPerimeter = async (surface: Locator) => {
    const perimeter = surface.locator(':scope > [data-slot="perimeter-light"]');
    await expect(perimeter).toHaveCount(1);
    const geometry = await surface.evaluate((element) => {
      const perimeter = element.querySelector<HTMLElement>(
        ':scope > [data-slot="perimeter-light"]',
      )!;
      const hostStyle = getComputedStyle(element);
      const perimeterStyle = getComputedStyle(perimeter);
      return {
        hostRadius: hostStyle.borderRadius,
        perimeterRadius: perimeterStyle.borderRadius,
        perimeterPointerEvents: perimeterStyle.pointerEvents,
        perimeterTransform: perimeterStyle.transform,
      };
    });
    expect(geometry.hostRadius).not.toBe('0px');
    expect(geometry.perimeterRadius).toBe(geometry.hostRadius);
    expect(geometry.perimeterPointerEvents).toBe('none');
    expect(geometry.perimeterTransform).toBe('none');
  };

  await assertRoundedPerimeter(
    page.getByRole('link', { name: 'Overview' }).first(),
  );
  await expect(page.locator('.host-capacity-card')).toHaveCount(4);
  await expect(
    page
      .locator('.assignment-status')
      .first()
      .locator(':scope > [data-slot="perimeter-light"]'),
  ).toHaveCount(0);
  await assertRoundedPerimeter(
    page
      .getByRole('banner')
      .getByRole('radiogroup', { name: 'View updates', exact: true }),
  );
  await assertRoundedPerimeter(
    page
      .getByRole('region', { name: 'Activity', exact: true })
      .getByRole('radiogroup', { name: 'Chart window', exact: true }),
  );

  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(
    page.locator('.gpu-card [data-slot="perimeter-light"]'),
  ).toHaveCount(0);
  await expect(page.locator('.gpu-board-view').first()).toBeVisible();
  const gpuControl = page.getByRole('button', {
    name: 'Open GPU 0 full GPU details',
  });
  await page.keyboard.press('Tab');
  await gpuControl.focus();
  expect(
    await gpuControl.evaluate((element) => element.matches(':focus-visible')),
  ).toBe(true);
  await expect(gpuControl).toHaveCSS('outline-style', 'solid');

  await page.getByRole('link', { name: 'Workloads' }).click();
  await assertRoundedPerimeter(page.locator('.workload-owner-tab').first());
  await assertRoundedPerimeter(
    page.locator('.mobile-workload-resource').first(),
  );

  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('link', { name: 'Overview' }).click();
  await assertRoundedPerimeter(page.locator('.chart-window-mobile').first());
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test('removes spatial motion when reduced motion is requested', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const light = testInfo.project.name.endsWith('-light');
  const ambientSnow = page.getByTestId('ambient-snow');
  await expect(ambientSnow).toHaveAttribute(
    'data-state',
    light ? 'hidden' : 'static',
  );
  await page.getByRole('link', { name: 'Resources' }).click();
  const resource = page.locator('.gpu-full-chip-button').first();
  await resource.hover();
  const motion = await page.locator('.workbench-view').evaluate((element) => {
    const view = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const mark = getComputedStyle(
      document.querySelector('[data-testid="leviathan-header-mark"]')!,
    );
    const ambientSnow = document.querySelector<HTMLCanvasElement>(
      '[data-testid="ambient-snow"]',
    )!;
    return {
      animationName: view.animationName,
      transform: view.transform,
      markAnimation: mark.animationName,
      ambientSnowDisplay: getComputedStyle(ambientSnow).display,
      ambientSnowState: ambientSnow.dataset.state,
      resourceTransform: getComputedStyle(
        document.querySelector('.gpu-full-chip-button')!,
      ).transform,
      durationToken: root.getPropertyValue('--duration-view').trim(),
    };
  });
  expect(motion.animationName).toBe('none');
  expect(motion.transform).toBe('none');
  expect(motion.markAnimation).toBe('none');
  expect(motion.ambientSnowDisplay).toBe(light ? 'none' : 'block');
  expect(motion.ambientSnowState).toBe(light ? 'hidden' : 'static');
  expect(motion.resourceTransform).toBe('none');
  expect(
    await page
      .locator('.gpu-card')
      .evaluateAll(
        (cards) =>
          cards
            .flatMap((card) => card.getAnimations({ subtree: true }))
            .filter((animation) => animation.playState === 'running').length,
      ),
  ).toBe(0);
  expect(motion.durationToken).toBe('240ms');
  if (!light) {
    await expect.poll(() => canvasFramesAreStable(ambientSnow)).toBe(true);
  }

  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const workloadResource = page
    .getByRole('button', {
      name: /^Open GPU \d+ · Full GPU details$/u,
    })
    .locator('xpath=..');
  await workloadResource.hover();
  await expect(workloadResource).toHaveCSS('transform', 'none');
  await expect
    .poll(async () => {
      // Streaming layout updates can scroll a narrow card away after hover.
      await workloadResource.hover();
      return workloadResource.evaluate((element) =>
        element.matches(':hover')
          ? getComputedStyle(element).boxShadow
          : 'none',
      );
    })
    .toContain(light ? '0px 20px 52px' : '0px 0px 52px');
});

test('removes ambient glass effects for visibility-oriented media preferences', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One dark desktop project covers the ambient media fallbacks.',
  );
  const ambientSnow = page.getByTestId('ambient-snow');
  const cap = page.locator('.snow-cap').first();
  await page.getByRole('link', { name: 'Workloads' }).click();
  await selectWorkloadOwner(page, 'synthetic-owner');
  const perimeter = page
    .getByRole('button', { name: /^Open GPU \d+ · Full GPU details$/u })
    .locator('xpath=..')
    .locator(':scope > [data-slot="perimeter-light"]');
  await perimeter.locator('xpath=..').hover();

  const visualState = () =>
    page.evaluate(() => {
      const snow = document.querySelector('[data-testid="ambient-snow"]')!;
      const cap = document.querySelector('.snow-cap')!;
      const panel = document.querySelector('.frost-panel')!;
      const perimeter = document.querySelector(
        '.interactive-resource > [data-slot="perimeter-light"]',
      )!;
      return {
        snow: getComputedStyle(snow).display,
        snowState: (snow as HTMLElement).dataset.state,
        cap: getComputedStyle(cap).display,
        backdrop: getComputedStyle(panel).backdropFilter,
        perimeter: getComputedStyle(perimeter).display,
      };
    });

  await expect(ambientSnow).toBeVisible();
  await expect(cap).toBeVisible();
  await expect(perimeter).toHaveCSS('display', 'block');
  await page.emulateMedia({ contrast: 'more' });
  await expect.poll(visualState).toMatchObject({
    snow: 'none',
    snowState: 'hidden',
    cap: 'none',
    backdrop: 'none',
    perimeter: 'none',
  });
  await page.emulateMedia({ contrast: 'no-preference' });
  await expect(ambientSnow).toHaveAttribute('data-state', 'running');

  await page.emulateMedia({ forcedColors: 'active' });
  await expect(perimeter).toHaveCSS('display', 'none');
  await page.emulateMedia({ forcedColors: 'none' });
  await expect(ambientSnow).toHaveAttribute('data-state', 'running');

  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  await expect.poll(visualState).toMatchObject({
    snow: 'none',
    snowState: 'hidden',
    cap: 'none',
    backdrop: 'none',
    perimeter: 'none',
  });
  await session.send('Emulation.setEmulatedMedia', { features: [] });
  await expect(ambientSnow).toHaveAttribute('data-state', 'running');

  expect(
    await page.evaluate(() => {
      const findSlowUpdateRule = (rules: CSSRuleList): boolean =>
        [...rules].some((rule) => {
          if (
            rule instanceof CSSMediaRule &&
            rule.conditionText.includes('update: slow')
          ) {
            const slowRules = [...rule.cssRules].filter(
              (child): child is CSSStyleRule => child instanceof CSSStyleRule,
            );
            return slowRules.some(
              (child) =>
                child.selectorText.includes('.perimeter-light') &&
                child.style.display === 'none',
            );
          }
          return (
            rule instanceof CSSGroupingRule && findSlowUpdateRule(rule.cssRules)
          );
        });
      return [...document.styleSheets].some((sheet) =>
        findSlowUpdateRule(sheet.cssRules),
      );
    }),
  ).toBe(true);
  await session.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5,
  });
  await expect
    .poll(() => page.evaluate(() => matchMedia('(pointer: coarse)').matches))
    .toBe(true);
  await expect(perimeter).toHaveCSS('display', 'none');
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
});

test('generated snow drifts remain stable through polling navigation and resizing and change with each page seed', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One project checks generated snow identity and theme gating.',
  );
  const collectCaps = () =>
    page.locator('.snow-capped > [data-slot="snow-cap"]').evaluateAll((caps) =>
      caps.map((cap) => ({
        key: cap.getAttribute('data-snow-surface'),
        profile: cap.getAttribute('data-snow-profile'),
        count: Number(cap.getAttribute('data-snow-piles')),
        bodies: [
          ...cap.querySelectorAll('[data-slot="snow-cap-body"] path'),
        ].map((path) => path.getAttribute('d')),
        shadows: cap.querySelectorAll('[data-slot="snow-cap-shadow"] path')
          .length,
        highlights: cap.querySelectorAll(
          '[data-slot="snow-cap-highlight"] path',
        ).length,
        layerCount: cap.parentElement!.querySelectorAll(
          ':scope > [data-slot="snow-cap"]',
        ).length,
      })),
    );
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  const initial = await collectCaps();
  expect(initial.length).toBeGreaterThan(1);
  expect(
    initial.every(
      ({ key, profile, count, bodies, shadows, highlights, layerCount }) =>
        Boolean(key) &&
        profile === 'generated' &&
        count >= 1 &&
        count <= 2 &&
        bodies.length === count &&
        shadows === count &&
        highlights === count &&
        layerCount === 1,
    ),
  ).toBe(true);
  expect(
    new Set(initial.map(({ bodies }) => JSON.stringify(bodies))).size,
  ).toBe(initial.length);
  const nextSnapshot = { ...snapshot, sequence: snapshot.sequence + 1 };
  await page.evaluate((next) => {
    (
      window as unknown as { __leviathanEventSource: EventTarget }
    ).__leviathanEventSource.dispatchEvent(
      new MessageEvent('snapshot', { data: JSON.stringify(next) }),
    );
  }, nextSnapshot);
  await expect.poll(collectCaps, { timeout: 20_000 }).toEqual(initial);
  for (const width of [320, 767, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(collectCaps, { timeout: 20_000 }).toEqual(initial);
    const visiblePaths = await page
      .locator('[data-slot="snow-cap-body"] path')
      .evaluateAll((paths) =>
        paths.every((path) => getComputedStyle(path).display !== 'none'),
      );
    expect(visiblePaths).toBe(true);
  }
  await page.getByRole('link', { name: 'Workloads' }).click();
  const workloads = await collectCaps();
  expect(workloads.every(({ count }) => count >= 1 && count <= 2)).toBe(true);
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect.poll(collectCaps, { timeout: 20_000 }).toEqual([]);
  await page.getByRole('link', { name: 'Resources' }).click();
  await expect.poll(collectCaps, { timeout: 20_000 }).toEqual(initial);
  await page.reload();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  await expect.poll(collectCaps, { timeout: 20_000 }).toEqual(initial);
  await page.evaluate(() =>
    sessionStorage.setItem('leviathan.test-snow-seed', '723991'),
  );
  await page.reload();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  const changed = await collectCaps();
  expect(changed.map(({ bodies }) => bodies)).not.toEqual(
    initial.map(({ bodies }) => bodies),
  );
  await page.getByRole('button', { name: 'Use light theme' }).click();
  for (const cap of await page.locator('.snow-cap').all())
    await expect(cap).toBeHidden();
});

test('unseeded page loads generate fresh accumulated snow', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop-dark',
    'One project verifies production-style per-page randomness.',
  );
  await page.evaluate(() =>
    sessionStorage.setItem('leviathan.test-snow-seed', 'random'),
  );
  await page.goto('/#resources');
  await page.reload();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  const paths = () =>
    page
      .locator('.gpu-card [data-slot="snow-cap-body"] path')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('d')),
      );
  const first = await paths();
  expect(first.length).toBeGreaterThanOrEqual(2);
  expect(first.length).toBeLessThanOrEqual(4);
  await page.reload();
  await expect(page.locator('.gpu-card')).toHaveCount(2);
  expect(await paths()).not.toEqual(first);
});
