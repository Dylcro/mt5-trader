import { describe, expect, it } from "vitest";

import type { Position } from "@/context/TradingContext";
import type { Zone } from "@/hooks/useZones";
import { buildCascadeComment } from "@/lib/zoneComments";
import {
  collectActiveZoneLinkedPositionIds,
  getLinkedPositionsForZone,
  pipelineBarFill,
  pipelineEnabledTps,
  pipelineSegmentProgress,
  positionsNotInActiveZones,
} from "./zoneDisplay";

function pos(id: string, overrides: Partial<Position> = {}): Position {
  return {
    id,
    symbol: "XAUUSD",
    type: "POSITION_TYPE_BUY",
    volume: 0.1,
    openPrice: 2500,
    currentPrice: 2501,
    profit: 10,
    time: "2025-06-01T00:00:00Z",
    ...overrides,
  };
}

function zone(zoneId: string, overrides: Partial<Zone> = {}): Zone {
  return {
    zoneId,
    direction: "buy",
    anchorPrice: 2500,
    tp1Price: 2510,
    tp2Price: 2520,
    tp3Price: 2530,
    tp4Price: null,
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    tp4Hit: false,
    cashoutDone: false,
    status: "OPEN",
    createdAt: Date.now(),
    positionCount: 1,
    ...overrides,
  };
}

describe("pipeline gold bar (sell + disabled TP1)", () => {
  const sellZone = zone("z_sell", {
    direction: "sell",
    anchorPrice: 2650,
    tp1Price: 2648,
    tp2Price: 2645,
    tp3Price: 2641,
    tp1Enabled: false,
    tp2Enabled: true,
    tp3Enabled: true,
  });

  it("skips disabled TP1 for next segment", () => {
    const steps = pipelineEnabledTps(sellZone);
    expect(steps.map((s) => s.level)).toEqual([2, 3]);
    const { nextStep, prevPrice, progressPct } = pipelineSegmentProgress(sellZone, steps, 2650);
    expect(nextStep?.level).toBe(2);
    expect(prevPrice).toBe(2650);
    expect(progressPct).toBe(0);
  });

  it("starts sell fill at SL side, not TP3 side", () => {
    const steps = pipelineEnabledTps(sellZone);
    const { progressPct } = pipelineSegmentProgress(sellZone, steps, 2650);
    expect(pipelineBarFill(steps, progressPct)).toBeLessThan(30);
  });
});

describe("getLinkedPositionsForZone", () => {
  const zoneId = "z_oneclick_anchor";

  it("includes tracked anchor when MT5 comment tag is missing", () => {
    const anchor = pos("88123", { comment: "" });
    const apiZone = zone(zoneId, { trackedPositionIds: ["88123"] });
    const linked = getLinkedPositionsForZone(zoneId, apiZone, [anchor]);
    expect(linked.map((p) => p.id)).toEqual(["88123"]);
  });

  it("merges comment-tagged legs with tracked IDs without duplicates", () => {
    const anchor = pos("88123", { comment: "" });
    const leg = pos("88124", { comment: buildCascadeComment(zoneId, 2, 4) });
    const apiZone = zone(zoneId, { trackedPositionIds: ["88123"] });
    const linked = getLinkedPositionsForZone(zoneId, apiZone, [anchor, leg]);
    expect(linked.map((p) => p.id).sort()).toEqual(["88123", "88124"]);
  });
});

describe("positionsNotInActiveZones (OPEN section dedupe)", () => {
  const zoneId = "z_oneclick_only";

  it("excludes one-click anchor from OPEN when only trackedPositionIds link it", () => {
    const anchor = pos("99001", { comment: "" });
    const manual = pos("99002", { comment: "manual scalp" });
    const apiZone = zone(zoneId, { trackedPositionIds: ["99001"] });
    const displayActive = [apiZone];
    const standalone = positionsNotInActiveZones([anchor, manual], displayActive, [apiZone]);
    expect(standalone.map((p) => p.id)).toEqual(["99002"]);
  });

  it("collectActiveZoneLinkedPositionIds matches linked set across display zones", () => {
    const anchor = pos("77001", { comment: "" });
    const apiZone = zone(zoneId, { trackedPositionIds: ["77001"] });
    const ids = collectActiveZoneLinkedPositionIds([apiZone], [apiZone], [anchor]);
    expect(ids.has("77001")).toBe(true);
    expect(ids.size).toBe(1);
  });
});
