import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // acceptance/*.spec.ts is Playwright, not vitest — but vitest's default
    // include is `**/*.{test,spec}.*`, so it collects the file, fails to find a
    // browser fixture, and reports a red suite that has nothing to do with the
    // code. Ownership is by directory: vitest owns src/ and test/, Playwright
    // owns acceptance/ (acceptance/playwright.config.ts).
    exclude: ["**/node_modules/**", "**/dist/**", "acceptance/**"],
    // Migrate once, before any suite. Without this, eight e2e suites race to
    // apply the same migrations against an empty database — see the comment in
    // test/global-setup.ts for why this only surfaces on a fresh machine.
    globalSetup: ["./test/global-setup.ts"],
    // e2e suites shell out to real `git` multiple times per test (clone,
    // push, merge) — the 5s default is fine for unit tests but flakes under
    // CI/sandbox disk contention once several suites run concurrently.
    //
    // Treat this as the floor for unit and integration tests, not as a budget
    // that survives contention: **a git-heavy e2e file is expected to set its
    // own per-test timeout**, and nine of them do (30_000 to 300_000). A file
    // that spawns `git` several times per test and takes the global will pass
    // alone and flake in the tier — a different test each run, which reads as
    // noise rather than as a missing timeout (#169). Raising this number
    // instead would slow the failure signal for every suite to fix one.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
