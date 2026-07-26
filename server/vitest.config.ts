import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e suites shell out to real `git` multiple times per test (clone,
    // push, merge) — the 5s default is fine for unit tests but flakes under
    // CI/sandbox disk contention once several suites run concurrently.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
