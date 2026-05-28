/**
 * Dependency drift detector.
 *
 * 1. Scans the catalog section of pnpm-workspace.yaml for any unpinned (^/~)
 *    version ranges — these would silently pull a different version the next
 *    time `pnpm install` runs in a fresh environment.
 *
 * 2. Runs `pnpm outdated --recursive --json` and prints a human-readable
 *    summary so drift from the pinned versions is visible at a glance.
 *    Packages documented in scripts/DEP_HOLD_BACKS.md are annotated with
 *    "hold" so the report stays actionable.
 *
 * Exit codes:
 *   0 — no catalog range issues found (outdated packages are reported but
 *       do not fail the check — they require a deliberate upgrade decision)
 *   1 — one or more catalog entries carry a range prefix (^/~)
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKSPACE_YAML = resolve(ROOT, "pnpm-workspace.yaml");
const HOLD_BACKS_MD = resolve(import.meta.dirname, "../DEP_HOLD_BACKS.md");

// ── 1. Catalog range check ────────────────────────────────────────────────────

/**
 * Parse the `catalog:` block out of a pnpm-workspace.yaml string and return
 * any entries whose version starts with ^ or ~.
 *
 * Key invariant: YAML top-level keys start at column 0 (no leading whitespace).
 * Catalog entries are indented, so we must check the RAW line — not a trimmed
 * copy — to decide whether we are entering or leaving the catalog block.
 */
function checkCatalogRanges(yamlText?: string): string[] {
  const raw = yamlText ?? readFileSync(WORKSPACE_YAML, "utf8");
  const issues: string[] = [];

  let inCatalog = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    // Detect top-level section headers using the raw line so that indented
    // catalog entries (which start with whitespace) never trigger this path.
    if (/^catalog\s*:/.test(line)) {
      inCatalog = true;
      continue;
    }
    // Any other top-level key (starts at column 0, non-empty, not a comment)
    // ends the catalog section.
    if (inCatalog && /^\S/.test(line) && trimmed !== "" && !trimmed.startsWith("#")) {
      inCatalog = false;
    }

    if (!inCatalog) continue;
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Match indented lines like:  some-package: ^1.2.3  or  'pkg': ~1.2.3
    const match = trimmed.match(/^['"]?([^'"]+?)['"]?\s*:\s*(['"]?)([~^].+?)\2\s*$/);
    if (match) {
      issues.push(`  ${match[1]}: ${match[3]}`);
    }
  }

  return issues;
}

// ── Self-test: verify the parser actually catches ranges ──────────────────────

function runSelfTest(): void {
  const fixture = `
packages:
  - artifacts/*

catalog:
  pinned-pkg: 1.2.3
  caret-pkg: ^1.2.3
  tilde-pkg: ~4.0.0
  also-pinned: 0.5.0

overrides:
  some-override: "npm:tsx@^4.21.0"
`.trimStart();

  const found = checkCatalogRanges(fixture);

  const wantedPackages = ["caret-pkg", "tilde-pkg"];
  const unwantedPackages = ["pinned-pkg", "also-pinned", "some-override"];

  let ok = true;

  for (const pkg of wantedPackages) {
    if (!found.some((f) => f.includes(pkg))) {
      console.error(`SELF-TEST FAIL  Expected range issue for "${pkg}" but it was not detected.`);
      ok = false;
    }
  }

  for (const pkg of unwantedPackages) {
    if (found.some((f) => f.includes(pkg))) {
      console.error(`SELF-TEST FAIL  "${pkg}" should NOT be flagged but was reported as a range.`);
      ok = false;
    }
  }

  if (ok) {
    console.log("PASS  Catalog parser self-test: correctly detects ^ and ~ ranges.");
  } else {
    console.error("Catalog parser self-test failed — fix the parser before trusting its output.");
    process.exit(1);
  }
}

runSelfTest();

const rangeIssues = checkCatalogRanges();

if (rangeIssues.length > 0) {
  console.error("FAIL  Unpinned ranges found in pnpm-workspace.yaml catalog:");
  for (const issue of rangeIssues) {
    console.error(issue);
  }
  console.error(
    "\nPin these to an exact version (remove the ^ or ~) so installs are reproducible."
  );
} else {
  console.log("PASS  All catalog entries are pinned to exact versions.");
}

// ── 2. Load approved hold-backs ───────────────────────────────────────────────

/**
 * Parse scripts/DEP_HOLD_BACKS.md and return a map of package-name → short reason.
 * Reads markdown table rows of the form:
 *   | `some-pkg` | ... | ... | reason text |
 * or:
 *   | `some-pkg` | ... | ... |
 */
function loadHoldBacks(): Map<string, string> {
  const holds = new Map<string, string>();
  if (!existsSync(HOLD_BACKS_MD)) return holds;

  const text = readFileSync(HOLD_BACKS_MD, "utf8");
  for (const line of text.split("\n")) {
    // Match table rows: | `pkg-name` | ... |
    const rowMatch = line.match(/^\|\s*`([^`]+)`\s*\|(.+)/);
    if (!rowMatch) continue;
    const pkgName = rowMatch[1].trim();
    // Skip header-style rows (pkg names that are actually column headers)
    if (pkgName === "Package") continue;
    // Extract the last non-empty cell as a short reason hint
    const cells = rowMatch[2].split("|").map((c) => c.trim()).filter(Boolean);
    // The reason is the last substantive cell (may be empty for ecosystem tables)
    const reason = cells[cells.length - 1] ?? "";
    holds.set(pkgName, reason);
  }
  return holds;
}

const holdBacks = loadHoldBacks();

// ── 3. Outdated packages report ───────────────────────────────────────────────

console.log("\nChecking for outdated packages (informational)…\n");

type OutdatedEntry = {
  current: string;
  latest: string;
  dependents?: string[];
};

type OutdatedReport = Record<string, OutdatedEntry>;

let outdatedReport: OutdatedReport = {};
let outdatedError = false;

try {
  const raw = execSync("pnpm outdated --recursive --json", {
    cwd: ROOT,
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    // pnpm exits non-zero when packages are outdated; ignore that
    timeout: 60_000,
  });
  try {
    outdatedReport = JSON.parse(raw) as OutdatedReport;
  } catch {
    // Some pnpm versions emit one JSON object per line — concatenate them
    const lines = raw.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        Object.assign(outdatedReport, JSON.parse(line));
      } catch {
        // non-JSON warning line — skip
      }
    }
  }
} catch (err: unknown) {
  const execErr = err as { stdout?: string; stderr?: string; status?: number };
  // pnpm exits 1 when outdated packages exist — that's expected
  const stdout = execErr.stdout ?? "";
  const stderr = execErr.stderr ?? "";

  if (stdout) {
    try {
      outdatedReport = JSON.parse(stdout) as OutdatedReport;
    } catch {
      const lines = stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          Object.assign(outdatedReport, JSON.parse(line));
        } catch {
          // skip
        }
      }
    }
  }

  // Only treat it as an unexpected error if we have stderr content and no data
  if (Object.keys(outdatedReport).length === 0 && stderr) {
    console.warn("Could not parse outdated output:", stderr.slice(0, 300));
    outdatedError = true;
  }
}

if (!outdatedError) {
  const entries = Object.entries(outdatedReport);
  if (entries.length === 0) {
    console.log("All packages are up to date.");
  } else {
    // Partition into action-needed vs documented hold-backs
    const actionNeeded: [string, OutdatedEntry][] = [];
    const onHold: [string, OutdatedEntry][] = [];

    for (const entry of entries) {
      if (holdBacks.has(entry[0])) {
        onHold.push(entry);
      } else {
        actionNeeded.push(entry);
      }
    }

    const width = { pkg: 0, cur: 7, lat: 6 };
    for (const [pkg, info] of entries) {
      width.pkg = Math.max(width.pkg, pkg.length);
      width.cur = Math.max(width.cur, (info.current ?? "").length);
      width.lat = Math.max(width.lat, (info.latest ?? "").length);
    }

    const pad = (s: string, n: number) => s.padEnd(n);
    const header = `${pad("Package", width.pkg)}  ${pad("Current", width.cur)}  ${pad("Latest", width.lat)}  Note`;
    const divider = `${"-".repeat(width.pkg)}  ${"-".repeat(width.cur)}  ${"-".repeat(width.lat)}  ----`;

    // ── Packages needing attention ────────────────────────────────────────────
    if (actionNeeded.length > 0) {
      console.log("=== ACTION NEEDED ===");
      console.log(header);
      console.log(divider);
      for (const [pkg, info] of actionNeeded.sort(([a], [b]) => a.localeCompare(b))) {
        const latest = info.latest ?? "unknown";
        const isDeprecated = latest === "Deprecated";
        const marker = isDeprecated ? "  ⚠  deprecated" : "";
        console.log(
          `${pad(pkg, width.pkg)}  ${pad(info.current ?? "?", width.cur)}  ${pad(latest, width.lat)}${marker}`
        );
      }
      console.log(`\n${actionNeeded.length} package(s) need review — run \`pnpm update <package>\` to bump.`);
    } else {
      console.log("PASS  All outdated packages are either up to date or have documented hold-backs.");
    }

    // ── Documented hold-backs ─────────────────────────────────────────────────
    if (onHold.length > 0) {
      console.log(`\n=== DOCUMENTED HOLD-BACKS (${onHold.length}) — see scripts/DEP_HOLD_BACKS.md ===`);
      console.log(header);
      console.log(divider);
      for (const [pkg, info] of onHold.sort(([a], [b]) => a.localeCompare(b))) {
        const latest = info.latest ?? "unknown";
        const reason = holdBacks.get(pkg) ?? "";
        const note = reason ? `hold: ${reason.slice(0, 60)}` : "hold: see DEP_HOLD_BACKS.md";
        console.log(
          `${pad(pkg, width.pkg)}  ${pad(info.current ?? "?", width.cur)}  ${pad(latest, width.lat)}  ${note}`
        );
      }
    }

    if (actionNeeded.length === 0 && onHold.length > 0) {
      console.log(`\n${onHold.length} package(s) are intentionally held — no action required.`);
    } else if (actionNeeded.length > 0) {
      console.log(`\n(${onHold.length} additional package(s) are intentionally held — see scripts/DEP_HOLD_BACKS.md)`);
    }
  }
}

// ── Exit ──────────────────────────────────────────────────────────────────────

process.exit(rangeIssues.length > 0 ? 1 : 0);
