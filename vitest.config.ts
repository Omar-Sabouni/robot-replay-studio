import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/core/**/*.ts", "src/reports.ts"],
      thresholds: {
        // Keep this gate at the measured whole-module baseline. Browser-only
        // worker/WebSocket paths are exercised by Playwright rather than
        // inflating unit coverage with DOM and transport mocks.
        lines: 65,
        functions: 75,
        statements: 65,
        branches: 55,
      },
    },
  },
});
