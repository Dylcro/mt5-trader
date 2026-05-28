/**
 * Playwright global setup — runs once before all smoke tests.
 *
 * Enforces required env vars so the deploy pipeline can never pass
 * without actually running the full cascade scenario.
 *
 * Required deploy-time secrets:
 *   SMOKE_BASE_URL    — deployed server URL (e.g. https://meta-trader-link.replit.app)
 *   ADMIN_KEY         — admin API key (guards /api/admin/status)
 *   DEMO_MT5_LOGIN    — MetaAPI demo account login number
 *   DEMO_MT5_PASSWORD — MetaAPI demo account password
 *   DEMO_MT5_SERVER   — MT5 broker server name (e.g. "MetaQuotes-Demo")
 */
export default function globalSetup(): void {
  const missing: string[] = [];

  if (!process.env.SMOKE_BASE_URL?.startsWith("http")) {
    missing.push("SMOKE_BASE_URL=https://meta-trader-link.replit.app");
  }
  if (!process.env.ADMIN_KEY) {
    missing.push("ADMIN_KEY=<your admin key>");
  }
  if (!process.env.DEMO_MT5_LOGIN) {
    missing.push("DEMO_MT5_LOGIN=<MT5 account number>");
  }
  if (!process.env.DEMO_MT5_PASSWORD) {
    missing.push("DEMO_MT5_PASSWORD=<MT5 password>");
  }
  if (!process.env.DEMO_MT5_SERVER) {
    missing.push("DEMO_MT5_SERVER=<broker server name>");
  }

  if (missing.length > 0) {
    throw new Error(
      "\n\n" +
        "❌  Required deploy-time secrets are missing for the smoke suite.\n\n" +
        "   Add the following to your deploy secrets before deploying:\n\n" +
        missing.map((s) => `     ${s}`).join("\n") +
        "\n\n" +
        "   Obtain a free MetaAPI demo account at https://app.metaapi.cloud\n" +
        "   and store its credentials as the DEMO_MT5_* secrets above.\n",
    );
  }

  console.log(`\n🔍  Smoke target: ${process.env.SMOKE_BASE_URL}\n`);
}
