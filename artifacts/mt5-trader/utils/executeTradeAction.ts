import { authFetch } from "@/lib/authFetch";

export async function executeTradeAction(
  url: string,
  body: object,
  onSuccess: () => void,
  onError: (msg: string) => void,
  setLoading: (v: boolean) => void,
) {
  setLoading(true);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Server error ${res.status}`);
    }

    await res.json();
    setLoading(false);
    onSuccess();
  } catch (err: unknown) {
    setLoading(false);

    const e = err as { name?: string; message?: string };
    if (e.name === "AbortError") {
      onError("Connection timed out — please try again");
    } else if (e.message?.includes("fetch")) {
      onError("No connection — please try again");
    } else {
      onError("Action failed — please try again");
    }

    console.error("[trade-action] failed:", err);
    return;
  }
}
