/** Identify CI / automated test accounts — never match real broker emails. */
export function isSmokeTestUser(u: { email: string; fullName?: string | null }): boolean {
  const e = u.email.toLowerCase().trim();
  const name = (u.fullName ?? "").trim().toLowerCase();

  if (e.startsWith("smoke+") && e.endsWith("@example.com")) return true;
  if (e.startsWith("cascade-smoke+") && e.endsWith("@example.com")) return true;
  if (e.includes("smoketest") || e.includes("playwright")) return true;
  if (name === "smoke test" || name === "cascade smoke") return true;
  if (name.includes("cascade smoke")) return true;

  return false;
}
