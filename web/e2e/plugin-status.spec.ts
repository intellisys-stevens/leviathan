import AxeBuilder from '@axe-core/playwright';
import { configureDashboardTests, expect, test } from './fixtures/dashboard';
import type { PluginReport } from '../src/use-plugin-report';

configureDashboardTests();

const report: PluginReport = {
  plugins: [
    {
      id: 'host',
      implementation: 'host-system',
      transport: 'builtin',
      status: 'available',
      dependencies: [],
      intervalMs: 500,
      capabilities: [
        {
          capability: 'system',
          revision: 'v1',
          enabled: true,
          status: 'available',
          observedAt: '2026-09-28T00:00:00Z',
          lastSuccess: '2026-09-28T00:00:00Z',
        },
      ],
    },
    {
      id: 'lab-accelerator',
      implementation: '',
      transport: 'unix',
      status: 'partial',
      dependencies: ['host'],
      intervalMs: 2000,
      capabilities: [
        {
          capability: 'device_inventory',
          revision: 'v2',
          enabled: true,
          status: 'stale',
          observedAt: '2026-09-27T23:59:00Z',
          lastSuccess: '2026-09-27T23:59:00Z',
          message: 'Source unavailable.',
        },
        {
          capability: 'custom_metrics',
          revision: 'v3',
          enabled: false,
          status: 'disabled',
        },
      ],
    },
  ],
};

test('plugin capabilities and freshness remain readable in Status', async ({
  page,
}, info) => {
  await page.route('**/api/v1/plugins', (route) =>
    route.fulfill({ json: report }),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('link', { name: 'Status', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Plugins', exact: true });
  await expect(
    panel.getByRole('heading', { name: 'lab-accelerator' }),
  ).toBeVisible();
  await expect(panel).toContainText('device_inventory');
  await expect(panel).toContainText('Source unavailable.');
  await expect(panel).toContainText('Unix socket');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await panel.scrollIntoViewIfNeeded();
  await panel.getByRole('button', { name: 'Refresh plugins' }).click();
  await expect(panel.getByRole('status')).toHaveCount(0);
  const refreshButton = panel.getByRole('button', { name: 'Refresh plugins' });
  await expect(refreshButton).toBeEnabled();
  // Inspect the rendered state at re-enablement, before a transition can finish.
  // Disabled controls may be muted; an enabled control must be readable at once.
  const enabledOpacity = await refreshButton.evaluate(async (element) => {
    const button = element as HTMLButtonElement;
    button.disabled = true;
    await Promise.all(
      button
        .getAnimations()
        .filter(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === 'opacity',
        )
        .map((animation) => animation.finished),
    );
    button.disabled = false;
    return getComputedStyle(button).opacity;
  });
  expect(enabledOpacity).toBe('1');
  await panel.screenshot({
    path: info.outputPath('plugins.png'),
    style:
      '.leviathan-header,.mobile-workbench-nav { visibility: hidden !important; }',
  });
  const violations = (
    await new AxeBuilder({ page })
      .include('#plugins-heading')
      .include('[aria-labelledby="plugins-heading"]')
      .analyze()
  ).violations;
  expect(
    violations.filter(
      ({ impact }) => impact === 'serious' || impact === 'critical',
    ),
  ).toEqual([]);
});

test('an unavailable plugin report leaves host status usable and refresh recovers', async ({
  page,
}) => {
  let unavailable = true;
  await page.route('**/api/v1/plugins', (route) =>
    route.fulfill(
      unavailable
        ? { status: 503, json: { error: 'unavailable' } }
        : { json: report },
    ),
  );
  await page.getByRole('link', { name: 'Status', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Plugins', exact: true });
  await expect(panel.getByRole('status')).toHaveText(
    'Plugin status is unavailable.',
  );
  await expect(
    page.getByRole('heading', { name: 'Status', level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Diagnostic details' }),
  ).toBeVisible();
  unavailable = false;
  await panel.getByRole('button', { name: 'Refresh plugins' }).click();
  await expect(
    panel.getByRole('heading', { name: 'host', exact: true }),
  ).toBeVisible();
});
