import { describe, expect, it } from "vitest";

import {
  londonPartsAt,
  tradingDayStartMs,
  weekTradingStartMs,
} from "./tradingDay";

describe("tradingDayStartMs (23:00 Europe/London)", () => {
  it("before 23:00 uses previous calendar day 23:00", () => {
    // 2025-06-03 22:30 BST = 21:30 UTC
    const now = new Date("2025-06-03T21:30:00.000Z");
    expect(londonPartsAt(now).hour).toBe(22);
    const start = tradingDayStartMs(now);
    expect(londonPartsAt(new Date(start))).toMatchObject({
      y: 2025,
      m: 6,
      d: 2,
      hour: 23,
      minute: 0,
    });
  });

  it("at or after 23:00 uses same calendar day 23:00", () => {
    // 2025-06-03 23:30 BST = 22:30 UTC
    const now = new Date("2025-06-03T22:30:00.000Z");
    const start = tradingDayStartMs(now);
    expect(londonPartsAt(new Date(start))).toMatchObject({
      y: 2025,
      m: 6,
      d: 3,
      hour: 23,
      minute: 0,
    });
  });

  it("winter GMT: 22:00 UK still previous trading day", () => {
    const now = new Date("2025-01-15T22:00:00.000Z"); // 22:00 GMT
    const start = tradingDayStartMs(now);
    expect(londonPartsAt(new Date(start))).toMatchObject({
      y: 2025,
      m: 1,
      d: 14,
      hour: 23,
      minute: 0,
    });
  });
});

describe("weekTradingStartMs", () => {
  it("Wednesday uses Monday 23:00 of same week", () => {
    const now = new Date("2025-06-04T12:00:00.000Z"); // Wed ~13:00 BST
    const start = weekTradingStartMs(now);
    expect(londonPartsAt(new Date(start))).toMatchObject({
      y: 2025,
      m: 6,
      d: 2,
      hour: 23,
      minute: 0,
    });
  });

  it("Monday before 23:00 uses previous Monday 23:00", () => {
    const now = new Date("2025-06-02T20:00:00.000Z"); // Mon 21:00 BST
    const start = weekTradingStartMs(now);
    expect(londonPartsAt(new Date(start))).toMatchObject({
      y: 2025,
      m: 5,
      d: 26,
      hour: 23,
      minute: 0,
    });
  });
});
