import { useCallback, useRef, useState } from "react";

import { useTrading } from "@/context/TradingContext";
import { getAuthToken } from "@/lib/authToken";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

function localReply(userText: string, ctx: { status: string; zonesHint: string }): string {
  const q = userText.toLowerCase();
  if (q.includes("cascade") || q.includes("tp")) {
    return (
      "Cascade trades layer limit orders with shared stop loss and up to four take-profit levels. " +
      "TP2 moves your stop to break-even when hit. Set TP4 to 0 pips in Settings to leave the final 25% open manually."
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

export function useAIAssistant() {
  const { status, accountId, positions } = useTrading();
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hi — ask me about cascade orders, take-profit levels, zones, or linking your MT5 account.",
      createdAt: Date.now(),
    },
  ]);
  const [sending, setSending] = useState(false);
  const idRef = useRef(1);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      const userMsg: AssistantMessage = {
        id: `u-${++idRef.current}`,
        role: "user",
        content: trimmed,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setSending(true);

      const zonesHint =
        positions.length > 0
          ? `${positions.length} open position(s)`
          : accountId
            ? "no open positions right now"
            : "no account linked";

      try {
        if (API_BASE) {
          const token = await getAuthToken();
          const res = await fetch(`${API_BASE}/mt5/assistant`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              message: trimmed,
              accountId: accountId || null,
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as { reply?: string };
            const reply = data.reply?.trim();
            if (reply) {
              setMessages((prev) => [
                ...prev,
                {
                  id: `a-${++idRef.current}`,
                  role: "assistant",
                  content: reply,
                  createdAt: Date.now(),
                },
              ]);
              return;
            }
          }
        }
      } catch {
        // fall through to local assistant
      }

      const reply = localReply(trimmed, { status, zonesHint });
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${++idRef.current}`,
          role: "assistant",
          content: reply,
          createdAt: Date.now(),
        },
      ]);
    },
    [accountId, positions.length, sending, status],
  );

  const clearChat = useCallback(() => {
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content:
          "Hi — ask me about cascade orders, take-profit levels, zones, or linking your MT5 account.",
        createdAt: Date.now(),
      },
    ]);
  }, []);

  return { messages, sending, sendMessage, clearChat };
}
