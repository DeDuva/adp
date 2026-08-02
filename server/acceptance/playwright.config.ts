import { defineConfig } from "@playwright/test";

// Driven by acceptance/run.sh, which owns the server, the fixture repo and the
// environment below — this config deliberately starts nothing itself. Running
// the spec standalone is possible but means supplying ADP_UI_* by hand.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // A cold browser plus a React mount over a real API; the default 30s is
  // enough locally but has no headroom on a loaded CI runner.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The UI is a supervision surface, not a product surface: one browser is the
  // right amount of coverage. Cross-browser matters when there are users.
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  use: {
    baseURL: process.env.ADP_UI_BASE,
    headless: true,
    screenshot: "only-on-failure",
    // Deterministic, so screenshots are comparable between runs.
    viewport: { width: 1280, height: 900 },
  },
  reporter: [["list"]],
  // Inside the run's artifact directory rather than server/test-results, so
  // `make down` removes it with everything else and verify-clean.sh does not
  // have to learn about a new path.
  outputDir: process.env.ADP_UI_ARTIFACTS
    ? `${process.env.ADP_UI_ARTIFACTS}/playwright`
    : undefined,
  // A retry would hide a genuinely flaky UI, which is worth knowing about.
  retries: 0,
  forbidOnly: true,
});
