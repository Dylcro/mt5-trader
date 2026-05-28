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

export function logEvent(event: EventName, data: EventData): void {
  console.log(JSON.stringify({ event, ts: Date.now(), ...data }));

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
