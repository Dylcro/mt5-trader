# Dependency Hold-Backs

Packages deliberately held below their latest version, with reasons.
Update this file whenever a hold-back is added, removed, or the reason changes.

---

## Major-version upgrades requiring dedicated code changes

These packages have breaking API changes that cannot be applied automatically.
Each needs its own focused migration task.

| Package | Pinned | Latest | Reason |
|---------|--------|--------|--------|
| `vite` | 7.x | 8.x | Vite 8 drops several plugin APIs and changes the dev-server startup contract. Upgrade together with `@vitejs/plugin-react`. |
| `@vitejs/plugin-react` | 5.x | 6.x | v6 requires Vite 8. Upgrade together with `vite`. |
| `zod` | 3.x | 4.x | Zod 4 is a complete API redesign (`z.string().email()` → `z.email()`, etc.). All schemas in `lib/api-zod`, `lib/db`, and everywhere `zod` is imported need migration. |
| `zod-validation-error` | 3.x | 5.x | API changes alongside Zod 4. Migrate together with `zod`. |
| `typescript` | 5.x | 6.x | TypeScript 6 introduces stricter rules that surface new errors in the existing codebase. Needs a dedicated audit. |
| `lucide-react` | 0.x | 1.x | v1.0 renamed and removed many icons. Requires a full grep of all icon imports across the codebase before upgrading. |
| `recharts` | 2.x | 3.x | Recharts 3 changed the chart component API. Requires updating every chart in the mockup-sandbox. |
| `react-day-picker` | 9.x | 10.x | Breaking API changes to the picker component interface. |
| `react-resizable-panels` | 2.x | 4.x | Large version jump with breaking layout and prop changes. |
| `@hookform/resolvers` | 3.x | 5.x | Breaking resolver API changes; coordinate with `react-hook-form` testing. |
| `chokidar` | 4.x | 5.x | Breaking API changes in the file-watcher interface. |
| `date-fns` | 3.x | 4.x | Breaking formatting and locale API changes in v4. |

---

## False positives (no real update available)

| Package | Reported | Actual status |
|---------|----------|--------------|
| `@types/bcryptjs` | 3.0.0 → 3.0.0 | Deprecated upstream; pnpm reports it as outdated even though latest is the same version. No upgrade path exists — switch to the types bundled in `bcryptjs` 3.x directly when convenient. |

---

## Overrides held for compatibility

| Package | Overridden to | Latest | Reason |
|---------|--------------|--------|--------|
| `esbuild` | 0.27.3 | 0.28.x | Override in `pnpm-workspace.yaml` replaces the vulnerable esbuild bundled inside `drizzle-kit`. Bump only after confirming drizzle-kit 0.31.x works with esbuild 0.28. |
