import rateLimit, { MemoryStore, type RateLimitRequestHandler } from "express-rate-limit";

// Hold an explicit reference to the store so admin endpoints can flush it
// (used to unblock users locked out by repeated failed-login attempts).
const authStore = new MemoryStore();

// Skip rate limiting for requests originating from localhost (smoke / CI runs)
function isLocalhost(req: import("express").Request): boolean {
  const ip = req.ip ?? req.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export const authLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many attempts. Please wait 15 minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false,
  store: authStore,
  skip: isLocalhost,
});

export const apiLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

export async function resetAuthLockouts(): Promise<{ ok: boolean; method: string; error?: string }> {
  try {
    await authStore.resetAll();
    return { ok: true, method: "MemoryStore.resetAll" };
  } catch (err) {
    return { ok: false, method: "MemoryStore.resetAll", error: (err as Error).message };
  }
}

export function resetAuthLockoutForKey(key: string): Promise<void> | void {
  return authStore.resetKey(key);
}
