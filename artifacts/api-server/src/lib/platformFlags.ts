import { db, adminSettingsTable, usersTable, waitlistTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isSmokeTestUser } from "./smokeUsers";

export type PlatformFlags = {
  membershipCap: number;
  inviteOnly: boolean;
  inviteCode: string | null;
  signupsOpen: boolean;
  tradingPaused: boolean;
  tradingPauseMessage: string;
};

const DEFAULTS: PlatformFlags = {
  membershipCap: 20,
  inviteOnly: false,
  inviteCode: null,
  signupsOpen: true,
  tradingPaused: false,
  tradingPauseMessage: "Trading is temporarily paused — we'll be back shortly.",
};

let cached: PlatformFlags = { ...DEFAULTS };

function rowToFlags(row: typeof adminSettingsTable.$inferSelect): PlatformFlags {
  return {
    membershipCap: row.membershipCap,
    inviteOnly: row.inviteOnly,
    inviteCode: row.inviteCode,
    signupsOpen: row.signupsOpen,
    tradingPaused: row.tradingPaused,
    tradingPauseMessage: row.tradingPauseMessage,
  };
}

export async function loadPlatformFlags(): Promise<void> {
  const rows = await db.select().from(adminSettingsTable).limit(1);
  if (rows[0]) {
    cached = rowToFlags(rows[0]);
    return;
  }
  const [inserted] = await db.insert(adminSettingsTable).values({}).returning();
  if (inserted) cached = rowToFlags(inserted);
}

export function getPlatformFlags(): PlatformFlags {
  return cached;
}

export async function updatePlatformFlags(patch: Partial<PlatformFlags>): Promise<PlatformFlags> {
  const next = { ...cached, ...patch };
  const [row] = await db.select({ id: adminSettingsTable.id }).from(adminSettingsTable).limit(1);
  if (!row) {
    await loadPlatformFlags();
    return updatePlatformFlags(patch);
  }
  await db.update(adminSettingsTable)
    .set({
      membershipCap: next.membershipCap,
      inviteOnly: next.inviteOnly,
      inviteCode: next.inviteCode,
      signupsOpen: next.signupsOpen,
      tradingPaused: next.tradingPaused,
      tradingPauseMessage: next.tradingPauseMessage,
    })
    .where(eq(adminSettingsTable.id, row.id));
  cached = next;
  return cached;
}

export function getTradingStatus(): { trading_enabled: boolean; message: string } {
  if (cached.tradingPaused) {
    return { trading_enabled: false, message: cached.tradingPauseMessage };
  }
  return { trading_enabled: true, message: "" };
}

/** Count app users excluding smoke-test accounts. */
export async function countRealUsers(): Promise<number> {
  const all = await db.select({ email: usersTable.email, fullName: usersTable.fullName }).from(usersTable);
  return all.filter((u) => !isSmokeTestUser(u)).length;
}

export async function addWaitlistEmail(email: string): Promise<void> {
  const normalized = email.toLowerCase().trim();
  await db.insert(waitlistTable)
    .values({ email: normalized, createdAt: Date.now(), status: "pending" })
    .onConflictDoNothing();
}

export function logAdminAction(action: string, detail: Record<string, unknown>): void {
  console.log(`[admin-action] ${action}`, JSON.stringify(detail));
}
