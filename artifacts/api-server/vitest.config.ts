import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // smoke.test.ts is included in all runs but its describe blocks
    // are guarded by describe.skipIf(!SMOKE_BASE_URL), so they
    // produce zero active tests unless SMOKE_BASE_URL is set.
    // No exclusion needed here — the guard handles skipping cleanly.
  },
});
