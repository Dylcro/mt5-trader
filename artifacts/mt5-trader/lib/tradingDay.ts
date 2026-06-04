/** MT5-style trading day roll — 23:00 Europe/London (after ~10–11pm close). */
export const TRADING_DAY_TZ = "Europe/London";
export const TRADING_DAY_ROLLOVER_HOUR = 23;

type LondonParts = { y: number; m: number; d: number; hour: number; minute: number };

export function londonPartsAt(instant: Date): LondonParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TRADING_DAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    y: parseInt(get("year"), 10),
    m: parseInt(get("month"), 10),
    d: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
  };
}

function compareLondon(
  a: LondonParts,
  b: Pick<LondonParts, "y" | "m" | "d" | "hour" | "minute">,
): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  if (a.d !== b.d) return a.d - b.d;
  if (a.hour !== b.hour) return a.hour - b.hour;
  return a.minute - b.minute;
}

/** UTC epoch ms for a wall-clock instant in Europe/London (handles GMT/BST). */
export function londonWallClockToMs(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute = 0,
): number {
  const target = { y, m, d, hour, minute };
  let lo = Date.UTC(y, m - 1, d - 1, hour, minute) - 3 * 3_600_000;
  let hi = Date.UTC(y, m - 1, d + 1, hour, minute) + 3 * 3_600_000;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const c = compareLondon(londonPartsAt(new Date(mid)), target);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  throw new Error(`London wall clock not found: ${y}-${m}-${d} ${hour}:${minute}`);
}

/** Shift calendar date in London (noon anchor avoids DST midnight edges). */
export function addLondonCalendarDays(
  y: number,
  m: number,
  d: number,
  deltaDays: number,
): Pick<LondonParts, "y" | "m" | "d"> {
  const noon = londonWallClockToMs(y, m, d, 12, 0);
  const shifted = londonPartsAt(new Date(noon + deltaDays * 86_400_000));
  return { y: shifted.y, m: shifted.m, d: shifted.d };
}

/** Monday=0 … Sunday=6 in Europe/London. */
export function londonWeekdayMonday0(instant: Date): number {
  const w = new Intl.DateTimeFormat("en-GB", {
    timeZone: TRADING_DAY_TZ,
    weekday: "short",
  }).format(instant);
  const map: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  return map[w] ?? 0;
}

/** Start of the current MT5 trading day (most recent 23:00 UK ≤ now). */
export function tradingDayStartMs(now: Date = new Date()): number {
  const p = londonPartsAt(now);
  const anchor =
    p.hour >= TRADING_DAY_ROLLOVER_HOUR
      ? { y: p.y, m: p.m, d: p.d }
      : addLondonCalendarDays(p.y, p.m, p.d, -1);
  return londonWallClockToMs(anchor.y, anchor.m, anchor.d, TRADING_DAY_ROLLOVER_HOUR, 0);
}

/** Start of the current trading week (Monday 23:00 UK, same roll as MT5 day). */
export function weekTradingStartMs(now: Date = new Date()): number {
  const p = londonPartsAt(now);
  const mon = addLondonCalendarDays(p.y, p.m, p.d, -londonWeekdayMonday0(now));
  let start = londonWallClockToMs(mon.y, mon.m, mon.d, TRADING_DAY_ROLLOVER_HOUR, 0);
  if (now.getTime() < start) {
    const prev = addLondonCalendarDays(mon.y, mon.m, mon.d, -7);
    start = londonWallClockToMs(prev.y, prev.m, prev.d, TRADING_DAY_ROLLOVER_HOUR, 0);
  }
  return start;
}
