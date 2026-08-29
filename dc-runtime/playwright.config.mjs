import { defineConfig } from '@playwright/test';

// The site is static: no server to boot, no database, no fixtures. These tests
// only need a browser, which is why they can live beside the build that
// produces the pages rather than in the acceptance tier.
export default defineConfig({
  testDir: './test',
  testMatch: '**/*.test.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    // Honour the same override make browser does.
    launchOptions: process.env.ADP_CHROMIUM_PATH
      ? { executablePath: process.env.ADP_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
