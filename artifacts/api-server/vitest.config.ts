import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests import mt5 routes, which loads @workspace/db at module init.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://127.0.0.1:5432/mt5_trader_test",
    },
    // Exclude Playwright spec files — they are run separately via `pnpm smoke`
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.spec.ts"],
  },
});
