import app from "./app";
import { ensureTables } from "./ensureTables";
import { loadCascadeConfig, startAutoConnect, startConnectionWatchdog, loadZoneState, startZoneTpMonitor, loadNotificationPrefs } from "./routes/mt5";
import { loadPlatformFlags } from "./lib/platformFlags";

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

async function main() {
  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  await ensureTables();

  // Load persisted cascade config from the database before accepting requests
  // so that GET /cascade-config never returns stale defaults on a fresh start.
  await loadCascadeConfig();
  await loadPlatformFlags();

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  // Reconnect all previously-seen MT5 accounts so auto-cascade works
  // immediately on startup — even when the app / phone is off.
  await startAutoConnect();

  // Watchdog: every 30 s, reconnect any account whose stream has dropped.
  startConnectionWatchdog();

  // Hydrate in-memory zone state from DB and start the 3 s TP monitor.
  await loadZoneState();
  await loadNotificationPrefs();
  startZoneTpMonitor();

}

main().catch((err) => {
  console.error("[startup]", err);
  process.exit(1);
});
