import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAssistantTurnCore } from "../../mt5-trader/lib/assistantTurn";

describe("runAssistantTurnCore — loading spinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears sending after a successful API reply", async () => {
    let sending = true;
    const setSending = (v: boolean) => { sending = v; };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ reply: "Hello from API" }),
    });

    const p = runAssistantTurnCore(
      "test question",
      { status: "connected", zonesHint: "none", accountId: "acc1", apiBase: "https://api.test" },
      {
        setSending,
        appendAssistant: () => {},
        fetchFn,
        getToken: async () => "tok",
      },
    );
    await vi.runAllTimersAsync();
    await p;

    expect(sending).toBe(false);
  });

  it("clears sending after API failure (falls back to local reply)", async () => {
    let sending = true;
    const setSending = (v: boolean) => { sending = v; };
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));

    const p = runAssistantTurnCore(
      "help",
      { status: "connected", zonesHint: "none", accountId: null, apiBase: "https://api.test" },
      {
        setSending,
        appendAssistant: () => {},
        fetchFn,
      },
    );
    await vi.runAllTimersAsync();
    await p;

    expect(sending).toBe(false);
  });
});
