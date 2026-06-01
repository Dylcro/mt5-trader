/** Testable assistant turn logic (no React hooks). */

const ASSISTANT_TIMEOUT_MS = 45_000;

function localReply(userText: string, ctx: { status: string; zonesHint: string }): string {
  const q = userText.toLowerCase();
  if (q.includes("cascade") || q.includes("tp")) {
    return (
      "Cascade trades layer limit orders with shared stop loss and up to four take-profit levels. " +
      "Settings → Auto break-even chooses when SL moves to BE (TP1, TP2, or TP3). Set TP4 to 0 pips to leave the final slice open manually."
    );
  }
  if (q.includes("connect") || q.includes("mt5") || q.includes("link")) {
    return (
      "Open Settings, enter your MT5 login, password, and server, pick your region, then tap Connect. " +
      "Your live feed appears once status shows connected."
    );
  }
  if (q.includes("zone") || q.includes("position")) {
    return `You have ${ctx.zonesHint}. Check the Positions tab for active zones and progress toward the next TP.`;
  }
  if (ctx.status !== "connected") {
    return "Link your MT5 account in Settings first — I can give more specific guidance once you're connected.";
  }
  return (
    "I'm your trading assistant. Ask about cascade setup, take-profit levels, zones, or connecting MT5. " +
    "For account issues, use Support in Settings."
  );
}

export async function runAssistantTurnCore(
  trimmed: string,
  ctx: { status: string; zonesHint: string; accountId: string | null; apiBase: string },
  opts: {
    appendAssistant: (content: string) => void;
    appendError?: (content: string) => void;
    setSending: (v: boolean) => void;
    fetchFn?: typeof fetch;
    getToken?: () => Promise<string | null>;
  },
): Promise<void> {
  opts.setSending(true);
  const timeout = setTimeout(() => {
    opts.setSending(false);
    opts.appendError?.("Something went wrong — try again.");
  }, ASSISTANT_TIMEOUT_MS);

  const fetchImpl = opts.fetchFn ?? fetch;

  try {
    if (ctx.apiBase) {
      const token = opts.getToken ? await opts.getToken() : null;
      const res = await fetchImpl(`${ctx.apiBase}/mt5/assistant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: trimmed,
          accountId: ctx.accountId || null,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { reply?: string };
        const reply = data.reply?.trim();
        if (reply) {
          opts.appendAssistant(reply);
          return;
        }
      }
    }
    opts.appendAssistant(localReply(trimmed, ctx));
  } catch {
    opts.appendAssistant(
      "I couldn't reach the server right now — here's what I know locally:\n\n" +
        localReply(trimmed, ctx),
    );
  } finally {
    clearTimeout(timeout);
    opts.setSending(false);
  }
}

export { runAssistantTurnCore as runAssistantTurn };
