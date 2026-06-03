# Cursor brief — Bug 3: History classification & win rate

The History tab mislabels zones and the win rate is wrong. Root cause: classification
checks the **close action** (manual/SL) before the **highest TP reached**, so hand-closed
zones that actually hit a TP get bucketed as MANUAL. Symptom in the data: 20 MANUAL, 4 TP1,
0 TP2/TP3/TP4 across 26 zones.

## ⚠️ SCOPE — read this first
**This is a stats/reporting fix only. Do NOT change how trades are placed, managed, or
closed.** The trade engine works correctly mechanically — only the classification and
win-rate maths are wrong. Touch only the code that *labels closed zones* and *computes the
History/Dashboard stats*.
- Allowed: reclassifying zones, fixing the win-rate calc, reading existing lifecycle data.
- Only permitted execution-adjacent change: if a needed fact isn't already stored (e.g. a
  "Risk Free was activated" flag, or price-at-close), **record/observe** it — never alter
  order placement, SL/TP logic, lot sizing, or cascade behaviour.
- If a fix seems to require an execution change, **stop and flag it** rather than changing it.

**Classify per ZONE (not per position). One label per zone, counts once toward win rate.**
TP ticks are cumulative (reaching TP3 ticks TP1+TP2+TP3).

---

## Precedence algorithm (first match wins)

Direction-aware: for a BUY, "reached TPn" = price traded **at/through** the TPn level;
"above TP3" = price > TP3 level. Mirror for SELL.

```
function classifyZone(zone):
  # 1) TP4 — manual close (app or MT5) while price is beyond the TP3 level
  if zone.closedManually and priceAtClose beyond TP3 level (in trade direction):
      return { label: "TP4", ticks: [TP1,TP2,TP3,TP4], outcome: WIN }

  # 2) Highest TP price level the zone reached
  maxTp = highest n in {1,2,3} where price reached TPn during the zone's life
  if maxTp >= 1:
      return { label: "TP"+maxTp, ticks: [TP1..TPmaxTp], outcome: WIN }
      # later SL or manual close after a TP is IGNORED — still a win, labelled by maxTp

  # 3) No TP reached
  if zone.rfActivated and zone.closedAtAdjustedStop:
      return { label: "RF", ticks: [], outcome: NEUTRAL }   # excluded from win rate

  if zone.closedAtOriginalStop:
      return { label: "SL", ticks: [], outcome: LOSS }

  if zone.closedManually:                                   # manual, before any TP
      return { label: "MANUAL", ticks: [],
               outcome: zone.finalPnl > 0 ? WIN : LOSS }     # blue=win, red=loss

  # fallback (shouldn't occur for a closed zone)
  return { label: "MANUAL", ticks: [], outcome: zone.finalPnl > 0 ? WIN : LOSS }
```

**The key change vs current code:** steps 1–2 (TP) run **before** step 3 (RF/SL/MANUAL).

## Win rate
```
wins    = zones with outcome == WIN
losses  = zones with outcome == LOSS
winRate = wins / (wins + losses)        # NEUTRAL (RF) excluded from numerator AND denominator
```
> CONFIRMED: RF is NEUTRAL — excluded from both numerator and denominator. An RF zone does
> nothing to the win rate. (If a zone goes RF then later runs to TP1+, it's no longer RF —
> it's a normal win, handled by step 2 above.)

## Inputs the classifier needs from the zone lifecycle
Make sure these are tracked/derivable per zone:
- highest TP **price level** reached (1/2/3) — independent of how it closed
- `closedManually` (app or MT5) and the **price at close**
- `rfActivated`, `closedAtAdjustedStop`, `closedAtOriginalStop`
- `finalPnl` (zone net realized, account currency)

---

## Acceptance tests (map 1:1 to the agreed scenarios)
1. Reaches TP2 (any number of entries hit TP1) → **TP2**, ticks TP1+TP2, **WIN**.
2. Hits TP1; that position closed by hand; zone re-collects an order and reaches TP2 →
   **TP2**, ticks TP1+TP2, **WIN** (NOT manual).
3. RF activated; adjusted stop hit before any TP → **RF**, **NEUTRAL** (not SL).
4. Hits TP1 then SL → **TP1**, **WIN** (SL ignored).
5. Straight to stop, no TP → **SL**, **LOSS**.
6. Reaches TP3 → **TP3**, ticks TP1+TP2+TP3, **WIN**.
7a. Manual close in profit before TP1 → **MANUAL**, **WIN**.
7b. Manual close in loss before TP1 → **MANUAL**, **LOSS**.
7c. Manual close after TP1 (below TP2) → **TP1**, **WIN** (NOT manual).
8.  Manual close above TP3 level → **TP4**, ticks TP1–TP4, **WIN**.
9.  RF activated then runs to TP1+ → labelled by highest TP, **WIN** (RF ignored).

## Backfill
If the History counts are stored, recompute existing zones with the new classifier so the
totals/win rate correct themselves; if they're computed on read, no backfill needed.
```
