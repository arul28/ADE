const LOCAL_DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function padCalendarComponent(value: number): string {
  return String(value).padStart(2, "0");
}

/** Returns the machine-local calendar day for an instant, or an empty string when invalid. */
export function localDayKey(value: Date | string | number): string {
  if (typeof value === "string" && LOCAL_DAY_KEY.test(value)) {
    return localDayStart(value) ? value : "";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${padCalendarComponent(date.getMonth() + 1)}-${padCalendarComponent(date.getDate())}`;
}

/** Parses a local day key at local midnight, rejecting normalized invalid dates. */
export function localDayStart(dayKey: string): Date | null {
  const match = LOCAL_DAY_KEY.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day, 0, 0, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== monthIndex
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function localDayOffset(value: Date | string | number, days: number): Date | null {
  const date = typeof value === "string" && LOCAL_DAY_KEY.test(value)
    ? localDayStart(value)
    : value instanceof Date ? value : new Date(value);
  if (!date) return null;
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 0, 0, 0, 0);
}

/** Stable ordinal for comparing local calendar keys without DST-length assumptions. */
export function localDayOrdinal(dayKey: string): number | null {
  const date = localDayStart(dayKey);
  if (!date) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}
