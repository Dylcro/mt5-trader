import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db, supportTicketsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { JWT_SECRET } from "./auth";

const router: IRouter = Router();

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Please sign in to send a support request." });
    return;
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { sub: string };
    (req as Record<string, unknown>)["userId"] = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}

router.post("/support", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Record<string, unknown>)["userId"] as string;
  const { name, email, query } = req.body as {
    name?: string;
    email?: string;
    query?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "Name is required." });
    return;
  }
  if (!query?.trim()) {
    res.status(400).json({ error: "Message is required." });
    return;
  }
  if (query.length > 5000) {
    res.status(400).json({ error: "Message is too long (max 5000 characters)." });
    return;
  }

  try {
    // Fall back to the signed-in user's email if none provided, so we can always reply.
    let resolvedEmail = email?.trim() || null;
    if (!resolvedEmail && userId) {
      try {
        const [u] = await db.select({ email: usersTable.email })
          .from(usersTable)
          .where(eq(usersTable.id, Number(userId)))
          .limit(1);
        if (u?.email) resolvedEmail = u.email;
      } catch { /* non-fatal */ }
    }

    await db.insert(supportTicketsTable).values({
      name: name.trim(),
      email: resolvedEmail,
      query: query.trim(),
      createdAt: Date.now(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[support] DB error:", (err as Error).message);
    res.status(500).json({ error: "Failed to save your request. Please try again." });
  }
});

export default router;
