import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const JWT_SECRET = process.env.ADMIN_KEY || "dev-jwt-secret-change-in-prod";
const JWT_EXPIRES_IN = "30d";

function makeToken(userId: number, email: string): string {
  return jwt.sign({ sub: String(userId), email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

router.post("/register", async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }

  try {
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
      .values({ email: email.toLowerCase().trim(), passwordHash })
      .returning({ id: usersTable.id, email: usersTable.email });

    res.json({ token: makeToken(user.id, user.email), user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("[auth/register]", err);
    res.status(500).json({ error: "Registration failed. Please try again." });
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

export { JWT_SECRET };
export default router;
