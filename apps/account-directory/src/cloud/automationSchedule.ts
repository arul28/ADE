/**
 * The next fire time of a cloud automation's schedule (C9): a 5-field cron
 * read in the rule's own IANA time zone, answered in UTC ms. The fields mean
 * what the desktop's schedule preview means (`computeNextScheduleAt` in
 * automationService.ts): `*`, `*\/n`, `a-b`, `a-b/n` and lists, Sunday as 0 or
 * 7, and every field must match (day of month and day of week together).
 *
 * Daylight saving time, in wall-clock terms:
 * - A time the clocks skip (02:30 on a spring-forward night) doesn't exist
 *   that day, so it doesn't fire that day.
 * - A time the clocks pass twice (01:30 on a fall-back night) fires once, at
 *   its first pass.
 */

const MAX_DAYS = 400;
const MINUTE_MS = 60_000;

type Field = ReadonlySet<number>;
type ParsedCron = { minutes: number[]; hours: number[]; days: Field; months: Field; weekdays: Field };

function parseField(raw: string, min: number, max: number, weekday = false): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [base = "", stepRaw] = part.trim().split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return null;
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else {
      const range = /^(\d+)(?:-(\d+))?$/.exec(base);
      if (!range) return null;
      start = Number(range[1]);
      end = range[2] === undefined ? (stepRaw === undefined ? start : max) : Number(range[2]);
    }
    const top = weekday ? 7 : max;
    if (start < min || end > top || start > end) return null;
    for (let value = start; value <= end; value += step) out.add(weekday && value === 7 ? 0 : value);
  }
  return out.size ? out : null;
}

/** A 5-field cron, or null when it isn't one. */
export function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseField(fields[0]!, 0, 59);
  const hours = parseField(fields[1]!, 0, 23);
  const days = parseField(fields[2]!, 1, 31);
  const months = parseField(fields[3]!, 1, 12);
  const weekdays = parseField(fields[4]!, 0, 6, true);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return { minutes: [...minutes].sort((a, b) => a - b), hours: [...hours].sort((a, b) => a - b), days, months, weekdays };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const made = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, made);
    return made;
  } catch {
    return null;
  }
}

/** True for a time zone this runtime knows (`Europe/Berlin`, `UTC`). */
export function isTimeZone(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && formatterFor(value) != null;
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

function wallAt(format: Intl.DateTimeFormat, at: number): Wall {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(at))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute! };
}

/** The zone's offset from UTC at `at`, in ms (positive east of Greenwich). */
function offsetAt(format: Intl.DateTimeFormat, at: number): number {
  const wall = wallAt(format, at);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return asUtc - Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

/**
 * The first UTC instant whose wall clock in the zone reads this time, or null
 * when the clocks skip it that day.
 */
function firstInstantOf(format: Intl.DateTimeFormat, wall: Wall): number | null {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // The zone's offsets half a day either side: two when a change falls near
  // the moment. Half a day, not hours: the true instant is the wall time less
  // an offset of up to 14 hours, and both sides of a change must be seen there.
  const offsets = new Set([offsetAt(format, naive - 14 * 60 * MINUTE_MS), offsetAt(format, naive), offsetAt(format, naive + 14 * 60 * MINUTE_MS)]);
  let first: number | null = null;
  for (const offset of offsets) {
    const instant = naive - offset;
    const back = wallAt(format, instant);
    const same = back.year === wall.year && back.month === wall.month && back.day === wall.day && back.hour === wall.hour && back.minute === wall.minute;
    if (same && (first == null || instant < first)) first = instant;
  }
  return first;
}

/**
 * The first fire strictly after `afterMs`, in UTC ms, or null when the cron or
 * the zone can't be read or nothing matches within about a year.
 */
export function nextFireAt(expression: string, timeZone: string, afterMs: number): number | null {
  const cron = parseCron(expression);
  const format = formatterFor(timeZone);
  if (!cron || !format) return null;
  const today = wallAt(format, afterMs);
  for (let offset = 0; offset < MAX_DAYS; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!cron.months.has(month) || !cron.days.has(day) || !cron.weekdays.has(date.getUTCDay())) continue;
    for (const hour of cron.hours) {
      // Today's hours well before now can't be after it (an hour of slack covers a clock change).
      if (offset === 0 && hour < today.hour - 1) continue;
      for (const minute of cron.minutes) {
        const instant = firstInstantOf(format, { year, month, day, hour, minute });
        // A wall time's first pass at or before `after` is spent: its second pass (fall back) doesn't fire again.
        if (instant != null && instant > afterMs) return instant;
      }
    }
  }
  return null;
}
