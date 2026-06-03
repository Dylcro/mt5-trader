import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  addWaitlistEmail,
  countRealUsers,
  getPlatformFlags,
  loadPlatformFlags,
} from "../lib/platformFlags";

const router = Router();

const JWT_SECRET = process.env.ADMIN_KEY || "dev-jwt-secret-change-in-prod";
const JWT_EXPIRES_IN = "30d";

function makeToken(userId: number, email: string): string {
  return jwt.sign({ sub: String(userId), email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function registerDbErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "23505") return "An account with this email already exists.";
  if (code === "42703") {
    return "Server database needs an update — republish the API on Replit (latest main).";
  }
  return "Registration failed. Please try again.";
}

router.post("/register", async (req: Request, res: Response): Promise<void> => {
  const { email, password, fullName, inviteCode } = req.body ?? {};

  try {
    // Always read fresh flags from DB (Replit can run multiple instances; in-memory cache can lag).
    await loadPlatformFlags();

    if (!fullName || typeof fullName !== "string" || fullName.trim().length < 2) {
      res.status(400).json({ error: "Please enter your full name." });
      return;
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      res.status(400).json({ error: "A valid email address is required." });
      return;
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }

    const flags = getPlatformFlags();
    if (!flags.signupsOpen) {
      await addWaitlistEmail(email);
      res.status(403).json({
        error: "Registration is closed. You've been added to the waitlist — we'll email you when a spot opens.",
        waitlist: true,
      });
      return;
    }
    if (flags.inviteOnly) {
      const code = typeof inviteCode === "string" ? inviteCode.trim() : "";
      if (!flags.inviteCode || code !== flags.inviteCode) {
        res.status(403).json({ error: "A valid invite code is required to sign up." });
        return;
      }
    }
    const realCount = await countRealUsers();
    if (realCount >= flags.membershipCap) {
      await addWaitlistEmail(email);
      res.status(403).json({
        error: "We're full for now. You've been added to the waitlist — we'll contact you when a spot opens.",
        waitlist: true,
      });
      return;
    }

    const existing = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase().trim()))
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [user] = await db.insert(usersTable)
      .values({ fullName: fullName.trim(), email: email.toLowerCase().trim(), passwordHash })
      .returning({ id: usersTable.id, email: usersTable.email, fullName: usersTable.fullName });

    res.json({ token: makeToken(user.id, user.email), user: { id: user.id, email: user.email, fullName: user.fullName } });
  } catch (err) {
    console.error("[auth/register]", err);
    res.status(500).json({ error: registerDbErrorMessage(err) });
  }
});

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  try {
    const [user] = await db.select()
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase().trim()))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }
    if (user.locked) {
      res.status(403).json({ error: user.lockedReason ?? "Your account is locked. Contact support." });
      return;
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    res.json({ token: makeToken(user.id, user.email), user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

router.get("/me", async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { sub: string; email: string };
    res.json({ user: { id: Number(payload.sub), email: payload.email } });
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
});

/** Join waitlist without registering (when cap is full). */
router.post("/waitlist", async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body ?? {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email is required." });
    return;
  }
  try {
    await addWaitlistEmail(email);
    res.json({ ok: true, message: "You're on the waitlist." });
  } catch (err) {
    console.error("[auth/waitlist]", err);
    res.status(500).json({ error: "Could not add to waitlist." });
  }
});

export { JWT_SECRET };
export default router;
