import { defineConfig } from "@playwright/test";

export default defineConfig({
  globalSetup: "./test/smoke.setup.ts",
  testMatch: ["**/test/smoke.spec.ts"],

  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "http://localhost:8080",
    extraHTTPHeaders: { "Content-Type": "application/json" },
  },

  timeout: 90_000,
  retries: 0,

  reporter: [["list"], ["json", { outputFile: "playwright-report/results.json" }]],
});
