import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
      JWT_SECRET: "test-secret",
      METAAPI_TOKEN: "test-token",
    },
    // Exclude Playwright spec files — they are run separately via `pnpm smoke`
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.spec.ts"],
  },
});
