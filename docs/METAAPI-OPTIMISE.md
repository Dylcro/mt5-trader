# MetaAPI Cost Optimisation — Add to existing changes before publishing

Add all of these to the server code you have already written.
Do not republish until all items below are in place.
All changes are server-side only — no app build needed for this file.

---

## 1 — Batch tick processor (read-only snapshot, live writes)

Instead of firing an independent evaluateZone per zone on every tick,
process one tick and evaluate all zones in a single pass using a
shared read-only snapshot.

```ts
// Replace individual per-zone tick handlers with one batch processor:

async function processTick(accountId: string, tick: Tick) {
  const zones = [...zoneStates.entries()]
    .filter(([_, st]) => st.accountId === accountId && st.status !== "CLOSED");

  if (zones.length === 0) return;
  if (!isMarketOpen()) return;

  // ONE snapshot fetch for all zones — read-only
  const snapshot = await getPositionsSnapshot(accountId, token, region);

  // Evaluate each zone using the shared snapshot
  // IMPORTANT: snapshot is never modified inside evaluateZone
  // Close actions go direct to MetaAPI, not back through snapshot
  for (const [zoneId, st] of zones) {
    try {
      await evaluateZone(zoneId, st, snapshot, tick);
    } catch (err) {
      console.error(`[eval] ${zoneId}:`, err);
    }
  }

  // Invalidate snapshot cache AFTER loop completes
  invalidatePositionsSnapshot(accountId);
}
```

Key rule: `evaluateZone` receives `snapshot` as a read-only parameter.
It reads positions from `snapshot` but executes any closes against
live MetaAPI directly. Do not allow evaluateZone to modify `snapshot`.

---

## 2 — Throttle evaluateZone to 1 second per zone minimum

Even with the batch processor, add a per-zone cooldown so the same
zone cannot be evaluated more than once per second:

```ts
const lastEvalTime = new Map<string, number>(); // zoneId → timestamp

async function evaluateZone(zoneId, st, snapshot, tick) {
  const last = lastEvalTime.get(zoneId) ?? 0;
  if (Date.now() - last < 1000) return; // skip if evaluated within 1s
  lastEvalTime.set(zoneId, Date.now());

  // ... existing evaluateZone logic
}
```

---

## 3 — Zone monitor: 10s interval, skip if stream eval recent

```ts
// Change zone monitor interval from 3s to 10s:
setInterval(async () => {
  for (const [zoneId, st] of zoneStates.entries()) {
    const last = lastEvalTime.get(zoneId) ?? 0;
    // Skip if stream already evaluated this zone within 12s
    if (Date.now() - last < 12_000) continue;
    await evaluateZone(zoneId, st, snapshot, null);
  }
}, 10_000);
```

---

## 4 — Periodic reconcile: 60s, account-level snapshot, only empty zones

```ts
// Change reconcile from 15s to 60s:
setInterval(async () => {
  // One REST call to get ALL positions for the account
  const allPositions = await fetchOpenPositions(token, region, accountId);
  const allOrders = await fetchPendingOrders(token, region, accountId);

  for (const [zoneId, st] of zoneStates.entries()) {
    if (st.status === "CLOSED") continue;

    const remaining = allPositions.filter(p => positionBelongsToZone(p, zoneId));
    const pending = allOrders.filter(o => belongsToZone(o, zoneId));

    // Only reconcile zones with no positions left — active zones
    // are already handled by the stream evaluator
    if (remaining.length === 0 && pending.length === 0) {
      console.log(`[reconcile] ${zoneId} empty — marking CLOSED`);
      await db.update(cascadeZonesTable)
        .set({ status: "CLOSED", closedAt: new Date().toISOString() })
        .where(eq(cascadeZonesTable.zoneId, zoneId));
      zoneStates.delete(zoneId);
      broadcastZoneUpdate(zoneId);
    }
  }
}, 60_000);
```

---

## 5 — REST snapshot cache: 5s with in-flight coalescing

All REST calls for positions and orders go through this cache.
Concurrent callers share one in-flight request rather than each
hitting MetaAPI separately.

```ts
const positionsCache = new Map<string, { data: any; ts: number; inflight?: Promise<any> }>();
const CACHE_TTL = 5_000; // 5 seconds

async function getPositionsSnapshot(accountId, token, region) {
  const cached = positionsCache.get(accountId);
  const now = Date.now();

  // Return cached data if fresh
  if (cached && now - cached.ts < CACHE_TTL) return cached.data;

  // Coalesce concurrent callers — return the same in-flight promise
  if (cached?.inflight) return cached.inflight;

  const inflight = fetchOpenPositions(token, region, accountId)
    .then(data => {
      positionsCache.set(accountId, { data, ts: Date.now() });
      return data;
    })
    .finally(() => {
      const entry = positionsCache.get(accountId);
      if (entry) delete entry.inflight;
    });

  positionsCache.set(accountId, { ...cached, inflight });
  return inflight;
}

function invalidatePositionsSnapshot(accountId: string) {
  positionsCache.delete(accountId);
}

// Call invalidatePositionsSnapshot after any successful close action
```

---

## 6 — TP price check: use streaming tick cache, REST as fallback

When evaluateZone needs to compare price against TP levels, use the
most recent tick received from the stream rather than making a REST call:

```ts
const tickCache = new Map<string, { bid: number; ask: number; time: number }>();

// Update on every stream tick:
function onTick(accountId, tick) {
  tickCache.set(accountId, { bid: tick.bid, ask: tick.ask, time: Date.now() });
  processTick(accountId, tick);
}

// In evaluateZone — use cached tick, fallback to REST only if stale:
async function getCurrentPrice(accountId, token, region) {
  const cached = tickCache.get(accountId);
  if (cached && Date.now() - cached.time < 15_000) {
    return cached; // use stream tick if within 15 seconds
  }
  // Fallback to REST only when stream has been quiet
  return await fetchCurrentPrice(token, region, accountId);
}
```

---

## 7 — Deal/position close events: targeted, not full reconcile

When MetaAPI fires a position_closed or deal event, only process
the affected zone rather than reconciling the entire account:

```ts
connection.addSynchronizationListener({
  onPositionRemoved: async (accountId, positionId) => {
    // Invalidate snapshot — positions have changed
    invalidatePositionsSnapshot(accountId);

    // Only reconcile the zone this position belonged to
    for (const [zoneId, st] of zoneStates.entries()) {
      if (st.positionIds?.includes(positionId)) {
        await reconcileZone(accountId, zoneId, token, region);
        break;
      }
    }
  },

  onDealAdded: async (accountId, deal) => {
    if (deal.entryType === "DEAL_ENTRY_OUT") {
      invalidatePositionsSnapshot(accountId);
    }
  }
});
```

---

## 8 — Exponential backoff on MetaAPI 429s

```ts
async function metaApiCallWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRateLimit = err?.status === 429 ||
        err?.message?.toLowerCase().includes("too many");
      if (isRateLimit && i < maxRetries - 1) {
        const wait = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        console.warn(`[metaapi] rate limited, waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

// Wrap all MetaAPI REST calls with metaApiCallWithBackoff
```

---

## 9 — Request rate monitor: warn at 60 calls/min per account

```ts
const reqCounts = new Map<string, number[]>(); // accountId → timestamps

function trackMetaApiCall(accountId: string) {
  const now = Date.now();
  const times = (reqCounts.get(accountId) ?? []).filter(t => now - t < 60_000);
  times.push(now);
  reqCounts.set(accountId, times);
  if (times.length > 60) {
    console.warn(`[req-rate] ${accountId} — ${times.length} MetaAPI calls in last 60s`);
  }
}

// Call trackMetaApiCall(accountId) at the start of every MetaAPI REST call
```

---

## 10 — Market hours: confirm evaluateZone returns immediately off-hours

Verify that `isMarketOpen()` is called at the top of the batch
tick processor AND the zone monitor AND the periodic reconcile:

```ts
function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;                  // Saturday
  if (day === 0 && hour < 23) return false;     // Sunday before 23:00 UTC
  if (day === 5 && hour >= 22) return false;    // Friday after 22:00 UTC
  return true;
}

// Add at top of processTick, zone monitor interval, and reconcile interval:
if (!isMarketOpen()) return;
```

---

## Summary of expected impact

| Change | Expected effect |
|---|---|
| Batch tick processor | Eliminates N concurrent REST calls per tick |
| 1s/zone throttle | Caps evaluation frequency |
| Zone monitor 10s + 12s skip | Stops duplicating stream work |
| 60s reconcile + account snapshot | 4× fewer reconcile calls |
| 5s REST cache + coalescing | Concurrent callers share one call |
| Tick cache for TP price | Eliminates per-eval price REST call |
| Targeted position close handler | No more full-account reconcile on every close |
| Exponential backoff | Stops hammering during rate limit |
| Market hours | Zero calls Fri 22:00 — Sun 23:00 UTC |

Watch [req-rate] in Railway logs after deploy.
If any account exceeds 60 calls/min the warning will show which one.
