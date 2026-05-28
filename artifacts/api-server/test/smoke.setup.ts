/**
 * Playwright global setup — runs once before all smoke tests.
 *
 * Fails hard if SMOKE_BASE_URL is not set so that the deploy pipeline
 * is never silently satisfied by a suite that ran zero assertions.
 */
export default function globalSetup(): void {
  const base = process.env.SMOKE_BASE_URL;
  if (!base || !base.startsWith("http")) {
    throw new Error(
      "\n\n" +
        "❌  SMOKE_BASE_URL env var is required to run the smoke suite.\n\n" +
        "   Set it to the deployed server URL in your deploy-time secrets:\n" +
        "     SMOKE_BASE_URL=https://meta-trader-link.replit.app\n\n" +
        "   For the full cascade scenario also add:\n" +
        "     DEMO_MT5_LOGIN=<login>\n" +
        "     DEMO_MT5_PASSWORD=<password>\n" +
        "     DEMO_MT5_SERVER=<broker server name>\n\n" +
        "   Without these secrets the smoke step is not a meaningful guard.\n",
    );
  }
  console.log(`\n🔍  Smoke target: ${base}\n`);
}
