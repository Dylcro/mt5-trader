# Cursor brief — Feature: "Secure Profits" button (API: close-worst)

Add a new action to the zone card that, when a zone has **2 or more open positions**, keeps
the **best** position and **closes one other leg per tap** — the rung nearest best on the
entry ladder (repeatable as price moves).

This is a deliberate **execution** feature (it closes live MT5 positions) — but keep it
surgical: it closes only the non-best positions, and does **nothing else**.

## Behaviour
- Trigger: user taps **Secure Profits** on an active zone (one leg per tap).
- Find that zone's **open** positions (match by the zone's magic number — see the multi-zone
  fix; do not rely on a global position list).
- If **< 2** open positions: button disabled / no-op.
- Determine the **best** position = the one with the highest current floating P&L.
  (BUY zone → lowest entry price; SELL zone → highest entry price. Same result in a same-lot
  cascade. Use floating P&L as the canonical measure so it's robust to unequal lots.)
- **Keep the best position open. Close one leg per tap** — the rung nearest best on the
  entry ladder (BUY: next limit above best, toward anchor; SELL: next below). The leg
  closed may be in profit or loss.
- **Cancel unfilled cascade limit orders** when the zone has already hit **TP2** (same rule as the
  automatic TP engine — never on TP1 only; pre-TP2 trims leave pending limits so the ladder can
  still fill).
- **Do NOT move the stop loss** on the surviving position, and do NOT change the zone SL.
  (This is the key difference from the Risk Free button, which moves the SL to break-even.)
- The zone **stays ACTIVE**, keeps its SL, and continues to cascade exactly as before.

## Interaction with Auto break-even (important)
The existing **Auto break-even** setting (moves SL to BE after a TP partial, e.g. after TP2)
must keep working **unchanged**. Close All Worst is a manual close, not a TP partial, so it
neither triggers nor suppresses auto-BE. After Close All Worst, the surviving position keeps
its current SL; if it later hits the configured TP partial, auto-BE moves the SL to BE as
normal. Do **not** treat "Close All Worst was used" as a reason to skip or disable auto-BE.

## What this must NOT do
- Must not move/modify any SL or TP.
- Must not change lot sizing, cascade settings, or how new orders are collected.
- Must not close the best position or close the whole zone.
- Must not trigger zone classification/stats — this is a **partial** close mid-zone (like
  Scenario 2). The zone is only labelled (TP/MANUAL/SL/RF) when the *whole* zone later closes.
- Ties (equal P&L): keep one deterministically (e.g. earliest ticket), close the rest.

## Backend
- New endpoint, e.g. `POST /api/zones/:id/close-worst`.
- Steps: load zone → fetch its open positions by magic → pick best by floating P&L →
  close the others via MetaAPI's close-position call → return the updated zone.
- Idempotent-ish: if only one (or none) open, return without closing anything.

## Frontend (Expo app — needs a TestFlight build)
- Add a **Close All Worst** button to the zone card. Current row is Risk Free / Close Zone /
  Delete Orders — adding a 4th will likely need a second row or a more compact layout;
  match the existing button styling.
- Disable/grey it when the zone has fewer than 2 open positions.
- Suggested: a quick confirm ("Close N worse positions? Best entry keeps running.") since it
  closes real positions — owner to confirm if they want the confirm step or instant action.

## Acceptance tests
- Zone with 4 open positions → tap → 3 worst close, best (top floating P&L) stays open, SL
  unchanged, zone still ACTIVE.
- BUY zone: surviving position is the **lowest** entry. SELL zone: the **highest** entry.
- Zone with 1 open position → button disabled / no-op.
- After the action, the zone can still cascade and collect new orders normally.
- The action does not add a row to History or change win-rate stats (zone still open).

## Release note
This one touches the **app UI**, so it needs an `eas build` → TestFlight (unlike the three
backend stats/logic fixes). The backend endpoint ships on the Replit publish.
