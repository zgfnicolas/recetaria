import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    globalSetup: ["./tests/setup/global-database.ts"],
    setupFiles: ["./tests/setup/env.ts"],
    pool: "forks",
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    sequence: { shuffle: true },
    env: { TZ: "UTC" },
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
