---
name: Cascade limit-attach race
description: Why limit orders silently failed to join their zone, breaking cashout / TPs
---

When the app submits a cascade, the market trade and N limit trades are POSTed in parallel for speed. The zone is only created when the *market* response succeeds (via `prepareZoneForCascade`, which seeds `pendingZoneAssoc`). Each limit response calls `attachLimitOrderToZone`, which reads `pendingZoneAssoc`.

If a limit response arrives **before** the market response, `pendingZoneAssoc` is empty and the limit orderId becomes an orphan. When that limit later fills, `onDealAdded` sees the orderId is a known cascade limit but `zoneLimitOrders.get(orderId)` is undefined, so `recordZonePositionFill` is never called. The position never lands in `zone_positions`, so the zone monitor's `live` undercounts and TPs/cashout silently skip that entry.

**Rule:** any time the api adds a step that depends on a per-account "pending association" set up by a sibling request, also add an orphan buffer that the late-arriving step drains. Pure pending-map lookups are racy when the trigger request can be beaten by its siblings.

**Orphan TTLs are NOT all equal:** the buffer's *expiry* TTL (when to forget the orphan) can be ~30s, but the *drain* window (how recently the orphan must have arrived to attach to a freshly-prepared zone) must be small — a few seconds — so leftover orphans from an earlier failed cascade attempt don't attach to a brand new zone. Real sibling-POST races resolve in milliseconds.

**Fill persistence must be retried.** `recordZonePositionFill` is the only thing that puts a fill into `zone_positions`. If that INSERT hits a transient DB error and is not retried, the position is forever invisible to `evaluateZone` (no row → not in `live` → TPs and any cashout-style logic skip it). Retry with backoff; do not let a single DB blip drop a real fill.

---

**Zone TP engine — current model (May 2026):**
- **No auto cashout.** The earlier rolling-per-entry cashout (close each upper entry when price clears its own openPrice by 5p) was removed at the user's request — they prefer to close upper entries manually. Do not re-add auto cashout without explicit ask. The `cashoutDone` / `cashoutPips` columns and state fields are legacy; leave them but stop relying on them.
- **All four cascade orders share the same SL and same TP1/2/3/4 prices** as the first entry. The mobile client already passes `stopLoss` on every cascade POST (market + 3 limits), so the broker holds the SL natively on each position. TP prices live only on the zone row; the engine drives the partial closes.
- **TP1-4 run against EVERY live entry**, not just a "best" survivor. At each TP level, close 25% of *that entry's* original volume. Per-entry gates (`p.volume > origVol * 0.76 / 0.51 / 0.26`) guard against double-closing the same level. TP4 (optional) closes whatever's left on every entry.
- **TP2 also cancels unfilled cascade limits** (don't add to a position that's already solidly in profit). TP2 does NOT move SLs to BE in this model — the broker SL placed at order time is the SL.
- **`zone_positions.volume` is the *original* per-position volume** (set once at fill, never updated by partial closes). Use it as the denominator for the 25% partial math; use the live position's current `volume` to decide whether the partial for this level has already been applied.
