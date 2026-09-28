/// <reference types="node" />
import { defineConfig } from '@playwright/test';
import process from 'node:process';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PLAYWRIGHT_PORT must be a TCP port number');
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  expect: {
    toHaveScreenshot: {
      // NVIDIA rasterizes some icon and WebGL edges differently. Allow three
      // pixels by default, preserving the software baselines and threshold.
      maxDiffPixels:
        process.env.PLAYWRIGHT_HARDWARE_GPU === '1' ? 3 : undefined,
    },
  },
  use: {
    baseURL,
    browserName: 'chromium',
    ...(process.env.PLAYWRIGHT_HARDWARE_GPU === '1'
      ? {
          launchOptions: {
            args: [
              '--enable-gpu',
              '--use-angle=vulkan',
              '--enable-features=Vulkan',
              '--disable-vulkan-surface',
            ],
          },
        }
      : {}),
    timezoneId: 'America/New_York',
    // Avoid continuous filmstrip readbacks competing with SwiftShader captures.
    // Keep DOM/action traces and each visual assertion's comparison images.
    trace: { mode: 'retain-on-failure', screenshots: false },
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
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
