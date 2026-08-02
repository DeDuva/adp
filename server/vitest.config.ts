import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Migrate once, before any suite. Without this, eight e2e suites race to
    // apply the same migrations against an empty database — see the comment in
    // test/global-setup.ts for why this only surfaces on a fresh machine.
    globalSetup: ["./test/global-setup.ts"],
    // e2e suites shell out to real `git` multiple times per test (clone,
    // push, merge) — the 5s default is fine for unit tests but flakes under
    // CI/sandbox disk contention once several suites run concurrently.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
