import { Router, type IRouter, type Request, type Response } from "express";
import { db, supportTicketsTable } from "@workspace/db";

const router: IRouter = Router();

router.post("/support", async (req: Request, res: Response) => {
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

  try {
    await db.insert(supportTicketsTable).values({
      name: name.trim(),
      email: email?.trim() || null,
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
