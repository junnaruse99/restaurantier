import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      // §9: la cobertura de packages/domain debe ser ≥ 90 %.
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
