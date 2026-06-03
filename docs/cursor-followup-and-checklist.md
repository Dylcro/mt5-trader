# Cursor follow-up — finish the merge + migration safety + checklist

The last merge left three items short and the migration keeps trying to drop columns. Below
is what to finish, why the Drizzle drops happen and how to stop them, and a verify checklist.

---

## Finish 1 — persist `slHit` (this IS in scope)
History shows SL = 0 because when MT5 closes a zone at the broker stop, nothing records that
it was an SL close. **Recording this is allowed** — it's reading deal history, not changing
trade execution. Do this:
- During reconcile, read each closed deal from MetaAPI and use the deal's **reason** field
  (SL / TP / stop-out vs client / mobile / expert) to detect an SL close. If reason isn't
  reliable, fall back to comparing the **close price to the zone's SL level**.
- Persist an `slHit` flag (and ideally the close reason) on the zone so the classifier can use
  it. This is what makes Scenario 5 (straight to SL) and Scenario 4 (TP1 then SL) work.

## Finish 2 — apply precedence everywhere + backfill
The "20 MANUAL / 0 TP2-4" pattern is still there because either (a) the highest-TP-before-
MANUAL precedence isn't applied at *every* classification site, or (b) existing zones were
never recomputed.
- Route **all** zone classification through the single classifier in
  `docs/zone-classification-spec.md`.
- **Backfill:** recompute the existing closed zones with the new classifier. Re-read MetaAPI
  deal history per zone where needed (highest TP reached, close reason) so old rows relabel
  correctly. After backfill, the History totals and win rate should self-correct.

## Build 3 — Close All Worst
Not built yet — implement per `docs/feature-close-all-worst.md` as its own commit. Needs
reliable per-zone position lookup (the magic-number work), so do that first if it isn't in.

---

## Migration safety — why Drizzle keeps trying to drop columns, and the fix
**Cause:** `drizzle-kit` diffs your **schema files** against the **live DB**. Columns that
exist in the DB but aren't declared in the schema (e.g. RF, legacy `users` columns) look
"extra," so it generates `DROP` statements to make the DB match the schema. The drift never
goes away, so it proposes the same drops every run. Running one would delete real data.

**Do NOT** run any migration that contains a `DROP`. Two ways forward:

**Safe now — hand-write an additive migration** (only adds the new zone columns, never drops):
```sql
ALTER TABLE cascade_zones ADD COLUMN IF NOT EXISTS magic     integer;
ALTER TABLE cascade_zones ADD COLUMN IF NOT EXISTS status    varchar(16) DEFAULT 'active';
ALTER TABLE cascade_zones ADD COLUMN IF NOT EXISTS closed_at timestamp;
-- give existing rows a magic, then add the unique constraint:
-- UPDATE cascade_zones SET magic = 990000 + id WHERE magic IS NULL;
-- ALTER TABLE cascade_zones ADD CONSTRAINT cascade_zones_magic_key UNIQUE (magic);
```
Adjust names/types to the real table. Apply this directly — it can't drop anything.

**Durable fix — stop the drop loop for good** (reconcile schema with reality):
1. `drizzle-kit pull` (introspect) the live Replit DB → generates a schema reflecting what's
   actually there, including the RF and legacy `users` columns.
2. Merge those missing columns into your hand-written schema files so **schema == DB**.
3. From then on, `drizzle-kit generate` only proposes `ADD`s for genuinely new columns — no
   more drop attempts.

Until the durable fix is done: always **review the generated SQL** and delete any `DROP`
lines (especially RF / `users`) before applying.

---

## Post-publish checklist (one quick pass against live MT5)
1. Zone hits **TP1** → History row = TP1, ticked, **win**; win rate updates.
2. Zone **stopped out** at broker SL → row = **SL**, **loss**, and the **SL counter
   increments** (confirms `slHit` now persists).
3. **Risk Free** a zone, let the adjusted stop hit → row = **RF**, win rate **unchanged**.
4. Manual close **in profit before TP1** → **MANUAL win**; **in loss before TP1** → MANUAL loss.
5. Manual close **above TP3** → **TP4**.
6. Two zones open → **Close All Worst** on one → best stays, **SL unchanged**, zone still
   **Active**, **no** new History row.
7. Totals sanity: TP1+TP2+TP3+TP4+MANUAL+RF+SL = closed zones; win rate = wins ÷
   (wins+losses), RF excluded.
