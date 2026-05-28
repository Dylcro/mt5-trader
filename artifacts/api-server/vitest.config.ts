import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude Playwright spec files — they are run separately via `pnpm smoke`
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.spec.ts"],
  },
});
