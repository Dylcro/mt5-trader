# TP Behaviour — Exact Spec
## Read this fully. Implement exactly this. Do not change anything else.

---

## The rules — simple version

**Every TP level fires on EVERY active leg independently.**
Not just the anchor. Not a combined total. Each position closes
its own configured percentage at each TP level.

**TP2 always does two extra things:**
1. Cancel all remaining pending limit orders for this zone
2. Move SL to break even (openPrice) on every remaining open position

**TP3 closes the % and sends the runner notification.**

**A leg that fills during a pullback gets its own TP ladder.**
It does not skip TP1 just because the anchor already hit TP1.
When price returns to TP1, that new leg closes its % too.

---

## Scenario 1 — Pullback activates limits

1. BUY anchor fills at market
2. Price rises → hits TP1
   → Anchor closes tp1Pct% of its own volume
   → No other legs active yet, nothing else happens
3. Price pulls back → limits 1, 2, 3 fill (new legs)
4. Price rises again → hits TP1 again
   → Each new leg closes tp1Pct% of its own volume (independently)
   → Anchor does NOT close again (already hit TP1)
5. Price continues → hits TP2
   → Every open leg closes tp2Pct% of its own volume
   → Cancel ALL remaining pending limits for this zone
   → Move SL to openPrice on ALL open positions in this zone
6. Price continues → hits TP3
   → Every open leg closes tp3Pct% of its own volume
   → Send push notification: "TP3 hit — set your runners 🏃"

---

## Scenario 2 — No pullback, straight run

1. BUY anchor fills at market
2. Price rises → hits TP1
   → Anchor closes tp1Pct% of its own volume
   → Pending limits never filled — still waiting
3. Price continues → hits TP2
   → Anchor closes tp2Pct% of its own volume
   → Cancel ALL remaining pending limits (they never filled)
   → Move SL to openPrice on anchor (only open position)
4. Price continues → hits TP3
   → Anchor closes tp3Pct% of its own volume
   → Send push notification: "TP3 hit — set your runners 🏃"

---

## Implementation rules

### Per-leg TP tracking
Track TP hits per position, not per zone:
```
zone_positions table: tp1_hit, tp2_hit, tp3_hit (boolean per row)
```
When evaluating a TP level, only close legs where that TP has NOT been hit yet.

### Before every TP fire — fresh broker read
Always fetch current open positions from broker before executing any TP close.
Never rely on a cached snapshot for the actual close decision.
Use cache only for the evaluation/check phase, not the execution phase.

### TP2 housekeeping — runs every time TP2 fires on any leg
```ts
async function applyTp2Housekeeping(zoneId, accountId, token, region) {
  // 1. Cancel all pending limits for this zone
  await cancelZoneLimits(accountId, zoneId, token, region);

  // 2. Move SL to break even on every open position in this zone
  const live = await fetchOpenPositions(token, region, accountId);
  const legs = live.filter(p => positionBelongsToZone(p, zoneId));
  for (const leg of legs) {
    await modifyPosition(token, region, accountId, leg.id, {
      stopLoss: leg.openPrice,
    });
  }
}
```
Call applyTp2Housekeeping once when the FIRST leg in the zone hits TP2.
For subsequent legs hitting TP2 (late fills), only move SL on that specific leg.
Track whether zone-level TP2 housekeeping has already run with a flag:
`zone_states: tp2_housekeeping_done (boolean)`

### TP percentages — use zone settings, not hardcoded values
```ts
const pct = lvl === 1 ? st.tp1Pct
           : lvl === 2 ? st.tp2Pct
           : st.tp3Pct;
const closeLots = Math.round(leg.originalVolume * pct / 100 / 0.01) * 0.01;
```

### Stream eval throttle — 500ms not 1s
The 1s throttle is causing TP delays. Set to 500ms:
```ts
const STREAMING_EVAL_MIN_INTERVAL_MS = 500;
```
Keep all other MetaAPI optimisations (cache, batch tick, market hours).
500ms is the balance between cost savings and TP speed.

### Late fills join at next available TP
If a limit fills AFTER zone TP1 has already fired:
- That leg starts with tp1_hit = false
- When price is still above TP1, immediately close tp1Pct% from that leg
- Do not wait for TP2. Close the missed TP level as soon as the leg is active.

### TAKE TP NOW button
Uses the same per-leg engine as auto TP.
Fires on every leg that hasn't hit that TP level yet.
No cooldown (emergency:true bypasses rate limit).
Shows correct level: "Take TP1" if any leg still needs TP1.

---

## What NOT to change
- Runner system — do not touch
- Zone creation / placement — do not touch
- Close Zone button — do not touch
- Secure Profits — do not touch
- Risk Free — do not touch
- App UI — no app changes needed for this spec
- MetaAPI optimisations (cache, batch, market hours) — keep all, just change throttle to 500ms

---

## Deploy
Server only → Railway deploy.
No EAS build needed.
