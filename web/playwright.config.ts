import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop-dark',
      use: { colorScheme: 'dark', viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'chromium-desktop-light',
      use: { colorScheme: 'light', viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'chromium-narrow-dark',
      use: { colorScheme: 'dark', viewport: { width: 360, height: 800 } },
    },
    {
      name: 'chromium-narrow-light',
      use: { colorScheme: 'light', viewport: { width: 360, height: 800 } },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
  },
});
