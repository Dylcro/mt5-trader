---
name: Cascade limit attach race
description: Cascade market + limit POSTs fire in parallel; limit POST responses can land before the market response's pendingZoneAssoc is set up — handled via orphanedCascadeLimits buffer.
---

When the mobile app fires a cascade, the BEST entry (market order) and the 7
cascade limit orders are POSTed in parallel. The limit POST responses can land
at the API server BEFORE the market POST response runs `prepareZoneForCascade`
to set up `pendingZoneAssoc` for the account. Without buffering, those limit
orderIds would have nothing to attach to.

**How it's handled today (`artifacts/api-server/src/routes/mt5.ts`):**
- `orphanedCascadeLimits: Map<accountId, {orderId, expiresAt, bufferedAt}[]>`
  buffers limit POST responses that arrive before the zone exists.
- `prepareZoneForCascade()` drains this buffer when the market POST runs,
  attaching only orphans buffered within `ZONE_ORPHAN_DRAIN_WINDOW_MS` (30 s)
  so stale entries from a previous failed cascade don't latch on.
- The drain window matches `ZONE_ASSOC_WINDOW_MS` because a slow market POST
  (>5s round-trip) was causing already-buffered limits to be rejected as
  "stale" once the market response finally created the zone — orphaning the
  resulting positions.

**Why this matters:** any new place that submits orders for a cascade must
either be inside the same prepare/attach window or it must also drain
`orphanedCascadeLimits`, otherwise filled positions end up as standalone
entries in the Positions tab when the zone closes.

**Related TP2 BE behavior:** the TP engine DOES move SLs to break-even at TP2
(this used to be skipped). See `artifacts/api-server/src/routes/mt5.ts` for
the sticky BE block — it pre-computes a broker-safe SL so price retracements
through entry don't trigger code 10016 "Invalid stops" rejections.
