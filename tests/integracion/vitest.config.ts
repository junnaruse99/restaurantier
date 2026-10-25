import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Comparten el stack local: se ejecutan en serie.
    fileParallelism: false,
  },
});
