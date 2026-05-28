---
name: Cascade limit-attach race
description: Why limit orders silently failed to join their zone, breaking cashout
---

When the app submits a cascade, the market trade and N limit trades are POSTed in parallel for speed. The zone is only created when the *market* response succeeds (via `prepareZoneForCascade`, which seeds `pendingZoneAssoc`). Each limit response calls `attachLimitOrderToZone`, which reads `pendingZoneAssoc`.

If a limit response arrives **before** the market response, `pendingZoneAssoc` is empty and the limit orderId becomes an orphan. When that limit later fills, `onDealAdded` sees the orderId is a known cascade limit but `zoneLimitOrders.get(orderId)` is undefined, so `recordZonePositionFill` is never called. The position never lands in `zone_positions`, so the zone monitor's `live.length` undercounts, and the cashout step (which requires `live.length > 1`) never fires.

**Rule:** any time the api adds a step that depends on a per-account "pending association" set up by a sibling request, also add an orphan buffer that the late-arriving step drains. Pure pending-map lookups are racy when the trigger request can be beaten by its siblings.

**How to apply:** when adding similar parallel-trade flows, buffer orphans keyed by accountId with the same TTL as the pending association, and drain in whichever function sets the pending association.

---

**Cashout strategy (not race-related, but lives in the same evaluateZone):** The cashout rule is **rolling per-entry**, not single-anchor. Each upper position closes the instant price clears *its own* openPrice by `cashoutPips` (5p default). The deepest entry (lowest BUY / highest SELL) is always preserved as "best" so TP1-4 keep running. Do not "fix" this back to a single anchor trigger — the user rejected that variant as too slow to react.

