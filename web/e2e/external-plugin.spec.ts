import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { configureDashboardTests, expect, test } from './fixtures/dashboard';
import type { Snapshot } from '../src/types';

// Replay unmodified HTTP responses from the independently compiled fixture
// plugin smoke test. Dates are fixed in the browser so captured capacity stays fresh.
const captureDirectory = process.env.LEVIATHAN_PLUGIN_ACCEPTANCE_DIR;
const captured = captureDirectory
  ? Object.fromEntries(
      ['snapshot', 'report', 'capacity'].map((name) => [
        name,
        readFileSync(join(captureDirectory, `plugin-api-${name}.json`), 'utf8'),
      ]),
    )
  : null;
const snapshot = captured
  ? (JSON.parse(captured.snapshot) as Snapshot)
  : undefined;

test.skip(
  !captured,
  'Set LEVIATHAN_PLUGIN_ACCEPTANCE_DIR to captured plugin API responses.',
);
configureDashboardTests({ initialSnapshot: snapshot });

test('external plugin API responses render across Resources, Workloads and Status', async ({
  page,
}, info) => {
  if (!captured || !snapshot)
    throw new Error('Plugin API responses are required.');
  for (const [name, body] of Object.entries(captured)) {
    await info.attach(`plugin-api-${name}.json`, {
      body,
      contentType: 'application/json',
    });
  }
  expect(snapshot.capabilities.gpu?.available).toBe(true);
  expect(snapshot.capabilities.nvml.available).toBe(false);
  await page.clock.setFixedTime(new Date(snapshot.sampledAt));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/v1/plugins', (route) =>
    route.fulfill({ body: captured.report, contentType: 'application/json' }),
  );
  await page.route('**/api/v1/gpu-capacity', (route) =>
    route.fulfill({ body: captured.capacity, contentType: 'application/json' }),
  );
  await page.route('**/api/v1/history/aligned', (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({ json: { ...request, points: [] } });
  });
  await page.route('**/api/v1/history?*', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: {
        entity: url.searchParams.get('entity'),
        window: url.searchParams.get('window'),
        points: [],
      },
    });
  });
  await page.reload();
  await page.getByRole('link', { name: 'Resources', exact: true }).click();
  const resources = page.getByRole('region', { name: 'GPUs', exact: true });
  await expect(resources).toContainText('Synthetic GPU');
  await expect(
    page.getByText('GPU discovery unavailable', { exact: true }),
  ).toHaveCount(0);
  const capacity = page.getByTestId('gpu-capacity-panel');
  await capacity.scrollIntoViewIfNeeded();
  await expect(capacity).toHaveAttribute('data-status', 'available');
  await expect(capacity.locator('[data-available="1"]')).toHaveText('1');
  await capacity.screenshot({
    path: info.outputPath('external-plugin-capacity.png'),
  });

  const historyRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/v1/history',
  );
  await page
    .getByRole('button', { name: 'Open GPU 0 full GPU details' })
    .click();
  expect(new URL((await historyRequest).url()).searchParams.get('entity')).toBe(
    snapshot.gpus[0].generation || snapshot.gpus[0].uuid,
  );
  const detail = page.getByRole('dialog');
  await expect(
    detail.getByTitle('Source: example_fixture').filter({ hasText: '50.0%' }),
  ).toBeVisible();
  await expect(
    detail.getByText('example-batch · job', { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole('heading', { name: 'Workload attribution' }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    ).violations.filter(
      ({ impact }) => impact === 'serious' || impact === 'critical',
    ),
  ).toEqual([]);
  await detail.screenshot({ path: info.outputPath('external-plugin-gpu.png') });
  await detail.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('link', { name: 'Workloads', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic batch job' }),
  ).toBeVisible();
  await expect(page.getByRole('tabpanel')).toContainText('Example owner');
  await expect(page.getByRole('tabpanel')).toContainText('1 workload');
  await expect(page.getByText('Preparing telemetry…')).toHaveCount(0);
  await page.getByRole('tabpanel').screenshot({
    path: info.outputPath('external-plugin-workload.png'),
    style:
      '.leviathan-header,.mobile-workbench-nav { visibility: hidden !important; }',
  });

  await page.getByRole('link', { name: 'Status', exact: true }).click();
  const plugins = page.getByRole('region', { name: 'Plugins', exact: true });
  await expect(
    plugins.getByRole('heading', { name: 'example', exact: true }),
  ).toBeVisible();
  await expect(plugins.getByRole('rowheader')).toHaveCount(7);
  await expect(plugins.getByText('available', { exact: true })).toHaveCount(8);
  await expect(
    page.getByRole('region', { name: 'Diagnostic details' }),
  ).not.toContainText(/NVML|GPU discovery/);
  await plugins.screenshot({
    path: info.outputPath('external-plugin-health.png'),
    style:
      '.leviathan-header,.mobile-workbench-nav { visibility: hidden !important; }',
  });
});
