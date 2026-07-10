/**
 * Turn a 5-field cron expression (minute hour day-of-month month day-of-week)
 * into a human gloss like "every weekday at 9:00am". Best-effort: anything it
 * can't confidently describe falls back to `at <cron>` so the raw expression is
 * still visible. Seconds are not supported (the engine's scheduler is 5-field).
 */

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatClock(hour: number, minute: number): string {
  const period = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = minute.toString().padStart(2, "0");
  return `${h12}:${mm}${period}`;
}

/** Normalize a day-of-week token: cron allows 0 or 7 for Sunday. */
function normalizeDow(value: number): number {
  return value === 7 ? 0 : value;
}

/** Expand a single field spec (ranges, lists, steps, single values) into concrete values, or null for wildcard. */
function expandField(spec: string, min: number, max: number): number[] | null {
  if (spec === "*" || spec === "*/1") return null;
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      let from = min;
      let to = max;
      if (stepMatch[1] !== "*") {
        const range = stepMatch[1]!.split("-").map(Number);
        from = range[0]!;
        to = range.length > 1 ? range[1]! : max;
      }
      if (!Number.isFinite(step) || step <= 0) return [];
      for (let v = from; v <= to; v += step) values.add(v);
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (rangeMatch) {
      for (let v = Number(rangeMatch[1]); v <= Number(rangeMatch[2]); v++) values.add(v);
      continue;
    }
    if (/^\d+$/.test(part)) {
      values.add(Number(part));
      continue;
    }
    // Unrecognized token — bail out of structured description.
    return [];
  }
  return [...values].sort((a, b) => a - b);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function describeDaysOfWeek(dows: number[]): string {
  const normalized = [...new Set(dows.map(normalizeDow))].sort((a, b) => a - b);
  const key = normalized.join(",");
  if (key === "1,2,3,4,5") return "every weekday";
  if (key === "0,6") return "every weekend day";
  return `every ${joinList(normalized.map((d) => DOW_NAMES[d] ?? `day ${d}`))}`;
}

function describeInterval(spec: string, min: number, max: number, unit: string): string | null {
  const stepMatch = /^\*\/(\d+)$/.exec(spec);
  if (!stepMatch) return null;
  const step = Number(stepMatch[1]);
  if (!Number.isFinite(step) || step <= 0) return null;
  void min;
  void max;
  return step === 1 ? `every ${unit}` : `every ${step} ${unit}s`;
}

export function describeCron(expr: string | null | undefined): string {
  const raw = (expr ?? "").trim();
  if (!raw) return "No schedule set";
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return `at ${raw}`;
  const [minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = fields as [string, string, string, string, string];

  // Sub-hour / sub-day intervals: "*/15 * * * *" or "0 */2 * * *".
  if (hourSpec === "*" && domSpec === "*" && monthSpec === "*" && dowSpec === "*") {
    const minuteInterval = describeInterval(minuteSpec, 0, 59, "minute");
    if (minuteInterval) return minuteInterval;
    if (minuteSpec === "0") return "every hour, on the hour";
    if (/^\d+$/.test(minuteSpec)) return `every hour at :${minuteSpec.padStart(2, "0")}`;
  }
  if (domSpec === "*" && monthSpec === "*" && dowSpec === "*" && minuteSpec === "0") {
    const hourInterval = describeInterval(hourSpec, 0, 23, "hour");
    if (hourInterval) return hourInterval;
  }

  // Time-of-day: a single concrete minute + hour.
  const minutes = expandField(minuteSpec, 0, 59);
  const hours = expandField(hourSpec, 0, 23);
  const singleMinute = minutes && minutes.length === 1 ? minutes[0]! : null;
  const singleHour = hours && hours.length === 1 ? hours[0]! : null;

  let timeClause = "";
  if (singleMinute != null && singleHour != null) {
    timeClause = ` at ${formatClock(singleHour, singleMinute)}`;
  } else if (singleHour != null) {
    timeClause = ` during the ${formatClock(singleHour, 0)} hour`;
  }

  // Day-of-week driven.
  const dows = expandField(dowSpec, 0, 7);
  if (dows && dows.length > 0 && domSpec === "*") {
    return `${describeDaysOfWeek(dows)}${timeClause}`.trim();
  }

  // Day-of-month driven.
  const doms = expandField(domSpec, 1, 31);
  if (doms && doms.length > 0) {
    const months = expandField(monthSpec, 1, 12);
    const dayClause =
      doms.length === 1 ? `on day ${doms[0]}` : `on days ${joinList(doms.map(String))}`;
    if (months && months.length > 0) {
      const monthClause = joinList(months.map((m) => MONTH_NAMES[m - 1] ?? `month ${m}`));
      return `${dayClause} of ${monthClause}${timeClause}`.trim();
    }
    return `${dayClause} of every month${timeClause}`.trim();
  }

  // Everyday at a time.
  if (domSpec === "*" && monthSpec === "*" && dowSpec === "*" && timeClause) {
    return `every day${timeClause}`.trim();
  }

  return `at ${raw}`;
}

/** Prefix the gloss for a rule sentence, e.g. "Every weekday at 9:00am". */
export function cronSentence(expr: string | null | undefined): string {
  const gloss = describeCron(expr);
  return gloss.charAt(0).toUpperCase() + gloss.slice(1);
}
