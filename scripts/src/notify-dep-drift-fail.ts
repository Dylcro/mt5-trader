/**
 * notify-dep-drift-fail.ts
 *
 * Sends an Expo push notification to every registered device when the
 * dep-drift check fails after a merge.
 *
 * Usage (called from post-merge.sh):
 *   echo "$DEP_DRIFT_OUTPUT" | tsx ./src/notify-dep-drift-fail.ts [pkg1 pkg2 …]
 *
 * - Reads the dep-drift output from stdin to extract flagged package names.
 * - Accepts an optional list of flagged packages as positional CLI args
 *   (used when stdin is not a pipe).
 * - Queries notification_prefs for all non-null expo_push_tokens.
 * - Fires push notifications via https://exp.host/--/api/v2/push/send.
 * - Always exits 0 — notification failure must never block the CI exit.
 *
 * Required env:
 *   DATABASE_URL — standard PostgreSQL connection string.
 */

import { createInterface } from "node:readline";
import pg from "pg";

const { Pool } = pg;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// ── 1. Collect flagged packages ───────────────────────────────────────────────

/**
 * Extract lines that look like package-range entries from dep-drift output,
 * e.g. "  some-pkg: ^1.2.3" → "some-pkg: ^1.2.3"
 */
function extractFlaggedPackages(text: string): string[] {
  const results: string[] = [];
  for (const line of text.split("\n")) {
    // dep-drift prints flagged entries indented with 2 spaces
    const match = line.match(/^\s{2}(\S.+:\s*[~^].+)$/);
    if (match) results.push(match[1].trim());
  }
  return results;
}

async function readStdin(): Promise<string> {
  // If stdin is a TTY (no pipe), return empty immediately.
  if (process.stdin.isTTY) return "";

  return new Promise((resolve) => {
    const chunks: string[] = [];
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => chunks.push(line));
    rl.on("close", () => resolve(chunks.join("\n")));
    // Safety timeout: don't block forever if stdin stalls
    setTimeout(() => {
      rl.close();
      resolve(chunks.join("\n"));
    }, 5_000);
  });
}

// ── 2. Fetch push tokens from the database ────────────────────────────────────

async function fetchPushTokens(databaseUrl: string): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 8_000 });
  try {
    const { rows } = await pool.query<{ expo_push_token: string }>(
      "SELECT expo_push_token FROM notification_prefs WHERE expo_push_token IS NOT NULL"
    );
    return rows.map((r) => r.expo_push_token).filter(Boolean);
  } finally {
    await pool.end();
  }
}

// ── 3. Send Expo push notifications ──────────────────────────────────────────

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  priority?: "default" | "normal" | "high";
}

async function sendExpoPush(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Expo push API returned ${response.status}: ${text}`);
  }
}

// ── 4. Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[notify-dep-drift-fail] DATABASE_URL not set — skipping push notification.");
    return;
  }

  // Collect context: stdin takes priority; CLI args used as fallback
  const stdinText = await readStdin();
  const cliPackages = process.argv.slice(2);

  const flaggedFromStdin = extractFlaggedPackages(stdinText);
  const flagged = flaggedFromStdin.length > 0 ? flaggedFromStdin : cliPackages;

  const summary =
    flagged.length > 0
      ? `Unpinned: ${flagged.slice(0, 3).join(", ")}${flagged.length > 3 ? ` +${flagged.length - 3} more` : ""}`
      : "One or more catalog entries use ^ or ~ ranges.";

  const body = `${summary}\n\nPin to an exact version in pnpm-workspace.yaml and push again.`;

  // Fetch registered tokens
  let tokens: string[];
  try {
    tokens = await fetchPushTokens(databaseUrl);
  } catch (err) {
    console.warn("[notify-dep-drift-fail] Could not fetch push tokens from DB:", (err as Error).message);
    return;
  }

  if (tokens.length === 0) {
    console.log("[notify-dep-drift-fail] No registered push tokens found — skipping notification.");
    return;
  }

  const messages: ExpoPushMessage[] = tokens
    .filter((t) => t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["))
    .map((to) => ({
      to,
      title: "Dep-drift check failed",
      body,
      priority: "high",
      data: { type: "dep-drift-fail" },
    }));

  if (messages.length === 0) {
    console.log("[notify-dep-drift-fail] No valid Expo push tokens found — skipping notification.");
    return;
  }

  try {
    await sendExpoPush(messages);
    console.log(`[notify-dep-drift-fail] Push notification sent to ${messages.length} device(s).`);
  } catch (err) {
    console.warn("[notify-dep-drift-fail] Push delivery failed:", (err as Error).message);
  }
}

main().catch((err) => {
  // Never crash the calling process — notification is best-effort
  console.warn("[notify-dep-drift-fail] Unexpected error:", (err as Error).message);
});
