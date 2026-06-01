import { useCallback, useRef, useState } from "react";

import { useTrading } from "@/context/TradingContext";
import { runAssistantTurnCore } from "@/lib/assistantTurn";
import { getAuthToken } from "@/lib/authToken";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export { runAssistantTurnCore as runAssistantTurn } from "@/lib/assistantTurn";

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

      const zonesHint =
        positions.length > 0
          ? `${positions.length} open position(s)`
          : accountId
            ? "no open positions right now"
            : "no account linked";

      await runAssistantTurnCore(
        trimmed,
        { status, zonesHint, accountId: accountId || null, apiBase: API_BASE },
        {
          setSending,
          getToken: getAuthToken,
          appendAssistant: (content) => {
            setMessages((prev) => [
              ...prev,
              {
                id: `a-${++idRef.current}`,
                role: "assistant",
                content,
                createdAt: Date.now(),
              },
            ]);
          },
          appendError: (content) => {
            setMessages((prev) => [
              ...prev,
              {
                id: `a-${++idRef.current}`,
                role: "assistant",
                content,
                createdAt: Date.now(),
              },
            ]);
          },
        },
      );
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
