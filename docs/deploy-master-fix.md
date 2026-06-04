# Master-fix deploy (copy-paste)

**Before TestFlight build:** Settings → Take Profit **OFF** in the current app.

**After new TestFlight build:** Take Profit **ON** for testing.

---

## 1. Merge on GitHub

https://github.com/Dylcro/mt5-trader/compare/main...cursor/master-fix-remaining?expand=1

Create PR → Merge → confirm `main` has latest.

---

## 2. Replit Shell → then click **Publish**

```bash
git fetch origin
git checkout main
git reset --hard origin/main
```

---

## 3. Mac terminal — iOS build + TestFlight submit

```bash
cd /Users/dylanjones/mt5-trader/artifacts/mt5-trader
git fetch origin
git checkout main
git pull origin main
eas build --platform ios --profile production --auto-submit
```

Two-step alternative:

```bash
cd /Users/dylanjones/mt5-trader/artifacts/mt5-trader
git fetch origin && git checkout main && git pull origin main
eas build --platform ios --profile production
eas submit --platform ios --latest
```

---

## Order

1. Merge GitHub PR  
2. Replit shell + Publish  
3. Mac terminal EAS  
4. App Store Connect → TestFlight → invite testers  
