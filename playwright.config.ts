import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: './output/playwright/results',
  reporter: [['list'], ['html', { outputFolder: './output/playwright/report', open: 'never' }]],
  use: {
    baseURL: process.env.NURSEBRIDGE_BASE_URL ?? 'http://localhost:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1050 },
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
});
