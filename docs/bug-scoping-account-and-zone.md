# Cursor brief — PRIORITY: scoping fix (isolate by ACCOUNT, then by ZONE)

This combines the cross-account and cross-zone bugs — they are **one root defect at two
boundaries**, and a single repro broke both. Fix them together; fixing one and leaving the
other is why this keeps coming back.

## The defect — one repro, both boundaries leaked
Setup: your account had a **buy zone** (lower) and a **sell zone** (above), both live; another
tester on a **separate MT5 account under the same MetaAPI token** had his own sell zone.
Action: you closed your **buy zone** in profit.
Result:
- Your **own sell zone's** limits were cancelled (the **zone** boundary leaked), and the
  surviving sell position got treated as inactive so its TPs stopped firing.
- The **other tester's** sell limits were also cancelled (the **account** boundary leaked).

Cause: cleanup/reconcile acts on too broad an order pool — not scoped to the acting account,
and not scoped to the acting zone within it.

## Fix — two layers, OUTER FIRST
**1. Account layer (outer):** every operation (place / close / cancel / cleanup / reconcile /
TP management) resolves the acting user → their **MetaAPI account ID** → that specific
connection, and acts **only** on it. Reconcile iterates **per account** and never reads or
touches another account's orders. (The shared MetaAPI token is fine — isolate by account ID,
not by token.)

**2. Zone layer (inner):** within that one account, scope to the specific zone by **magic**.
Closing zone A cancels **only** zone A's orders. A zone with **any** live leg (open position
or its own pending order) stays **ACTIVE** with TP management armed — never marked inactive
while it has a live leg.

Order matters: there's no point isolating zones if the account boundary still leaks. Get the
account scope right first, then the zone scope within it.

## Keystone — reliable identity at both levels
- A solid **user → MetaAPI account ID** mapping.
- A reliable **per-zone magic** within each account.
- Every lookup, cleanup, and reconcile filters by **both** (correct account, then correct
  zone). Magic must never be what separates *users* — that is the account ID's job.

## Diagnose to confirm (instrument first)
Log every cancel / cleanup / reconcile with: the **account ID** it operates on, the **owning
user**, and each affected order's **account ID + magic + owning zone**. Expect to see the
buy-zone close touching (a) sell-zone orders in your **own** account, and (b) orders in the
**other** account. Both confirmations = both boundaries leaking.

## Acceptance test (your exact repro — must pass)
- Your account: buy zone (lower) + sell zone (above), both live. Other tester: separate
  account, same token, his own sell zone.
- Close your buy zone in profit. Expected:
  - Your **sell zone limits remain**, the sell zone stays **ACTIVE**, and its **TPs fire** at
    their levels.
  - The other tester's orders/positions are **completely untouched**.
- Reverse cases: close the sell zone → buy zone untouched; the other tester acts → your
  account untouched.

## Scope guardrail
Surgical: change only the **scoping of operations/cleanup/reconcile** and the **identity
mappings** (user→account, zone→magic), plus the **zone-active / TP-management gating**. Do not
change order placement, TP price levels, lot sizing, or cascade behaviour.
