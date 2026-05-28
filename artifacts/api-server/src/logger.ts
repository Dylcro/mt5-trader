import { recordTradeFail, recordRateLimit } from "./telemetry";

export type EventName =
  | "stream.connect"
  | "stream.disconnect"
  | "trade.ok"
  | "trade.fail"
  | "zone.create"
  | "zone.close"
  | "rate.hit";

type EventData = Record<string, unknown>;

const OUTCOME: Record<EventName, string> = {
  "stream.connect":    "connected",
  "stream.disconnect": "disconnected",
  "trade.ok":          "ok",
  "trade.fail":        "fail",
  "zone.create":       "created",
  "zone.close":        "closed",
  "rate.hit":          "hit",
};

export function logEvent(event: EventName, data: EventData): void {
  console.log(JSON.stringify({ event, ts: Date.now(), outcome: OUTCOME[event], ...data }));

  if (event === "trade.fail") {
    recordTradeFail({
      ts: Date.now(),
      accountId: String(data["accountId"] ?? ""),
      action: String(data["action"] ?? ""),
      code: Number(data["code"] ?? 0),
      message: String(data["message"] ?? ""),
      positionId: data["positionId"] != null ? String(data["positionId"]) : null,
    });
  }
  if (event === "rate.hit") {
    recordRateLimit({ ts: Date.now(), accountId: String(data["accountId"] ?? "") });
  }
}
