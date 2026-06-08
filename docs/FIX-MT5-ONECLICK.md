# Feature: Auto-Cascade from MT5 One-Click

## What this does
When the user one-click buys or sells in MT5 directly, the server
detects the new position and automatically fires the same cascade
the app would have placed. Zone appears in the app instantly.

Nothing about the cascade changes — same settings, same logic,
same TP levels, same limits. This is just a new entry point.

---

## Server — api-server/src/routes/mt5.ts

### Add onPositionAdded listener to MetaAPI stream

```ts
connection.addSynchronizationListener({
  onPositionAdded: async (accountId: string, position: any) => {
    try {
      // Only handle XAUUSD (or configured symbol)
      if (position.symbol !== "XAUUSD") return;

      // Skip if already part of a zone (tagged in comment)
      if (position.comment?.includes("zone:")) return;

      // Check user has auto-cascade enabled in settings
      const settings = await getAccountSettings(accountId);
      if (!settings?.autoCascadeEnabled) return;

      // Avoid duplicate zone creation if position already registered
      const existing = [...zoneStates.values()]
        .find(z => z.anchorPositionId === position.id);
      if (existing) return;

      console.log(`[auto-cascade] MT5 one-click detected — ${position.type} ${position.symbol} @ ${position.openPrice}`);

      // Use the same zone creation function the app uses
      // position becomes the anchor
      await createZoneFromAnchor(accountId, {
        anchorPositionId: position.id,
        anchorPrice:      position.openPrice,
        direction:        position.type === "POSITION_TYPE_BUY" ? "buy" : "sell",
        originalVolume:   position.volume,
        symbol:           position.symbol,
        // All TP and cascade settings come from user settings
        tp1Pct:           settings.tp1Pct,
        tp2Pct:           settings.tp2Pct,
        tp3Pct:           settings.tp3Pct,
        tp1Price:         null, // calculated from settings pip distances
        tp2Price:         null,
        tp3Price:         null,
        limitCount:       settings.limitCount   ?? 3,
        limitSpacingPips: settings.limitSpacing ?? 10,
        lotSize:          settings.lotSize,
      }, token, region);

      // Push notification to user's phone
      await sendPushNotification(accountId, {
        title: `📊 Zone created — ${position.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL"} ${position.openPrice}`,
        body:  "MT5 one-click detected · cascade placed automatically",
        data:  { type: "zone_created", direction: position.type },
      });

    } catch (err) {
      console.error("[auto-cascade] failed:", err);
    }
  }
});
```

### createZoneFromAnchor

This should call the SAME internal function that the app's
POST /zones endpoint calls. Do not duplicate logic — reuse it:

```ts
async function createZoneFromAnchor(accountId, params, token, region) {
  // 1. Generate a zoneId
  const zoneId = generateZoneId();

  // 2. Calculate TP prices from anchor + pip distances in settings
  //    (same calculation as app zone creation)
  const tp1Price = calculateTpPrice(params.anchorPrice, params.direction,
    settings.tp1DistancePips);
  const tp2Price = calculateTpPrice(params.anchorPrice, params.direction,
    settings.tp2DistancePips);
  const tp3Price = calculateTpPrice(params.anchorPrice, params.direction,
    settings.tp3DistancePips);

  // 3. Place cascade limit orders (same as app zone creation)
  await placeCascadeLimits(accountId, zoneId, {
    ...params, tp1Price, tp2Price, tp3Price,
  }, token, region);

  // 4. Save zone to DB
  await db.insert(cascadeZonesTable).values({
    zoneId,
    accountId,
    anchorPrice:      params.anchorPrice,
    anchorPositionId: params.anchorPositionId,
    direction:        params.direction,
    originalVolume:   params.originalVolume,
    tp1Price, tp2Price, tp3Price,
    tp1Pct:           params.tp1Pct,
    tp2Pct:           params.tp2Pct,
    tp3Pct:           params.tp3Pct,
    status:           "ACTIVE",
    createdAt:        new Date().toISOString(),
  });

  // 5. Register in zoneStates and broadcast to app
  zoneStates.set(zoneId, { zoneId, accountId, ...params,
    tp1Price, tp2Price, tp3Price, status: "ACTIVE" });
  broadcastZoneUpdate(zoneId);

  return zoneId;
}
```

---

## App — Settings screen

Add a single toggle below the existing cascade settings:

```tsx
// In Settings screen, under TP / cascade section:

<View style={styles.settingRow}>
  <View style={{ flex: 1 }}>
    <Text style={styles.settingLabel}>Auto-cascade on MT5 one-click</Text>
    <Text style={styles.settingSubLabel}>
      Tap buy/sell in MT5 and the cascade fires automatically
    </Text>
  </View>
  <Switch
    value={autoCascadeEnabled}
    onValueChange={async (val) => {
      setAutoCascadeEnabled(val);
      await saveSettings({ autoCascadeEnabled: val });
    }}
    trackColor={{ true: "#C9892E" }}
  />
</View>
```

Persist to AsyncStorage key: `autoCascadeEnabled`
Default: `false` (opt-in, not on by default)
Send to server with other settings so `getAccountSettings` returns it.

---

## What does NOT change
- Zone creation logic — reused as-is
- TP levels — same as app-created zones
- Cascade limits — same spacing and count from settings
- Auto-TP engine — unchanged
- Runner system — unchanged
- All existing buttons — unchanged

---

## Deploy
Server → Railway deploy (git push).
App → EAS build (settings toggle only — small change).
