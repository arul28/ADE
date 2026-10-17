/** `1 tool`, `2 tools`, `0 files`. */
export function pluralCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Format a byte count into a short human-readable size (e.g. "1.4 GB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * Case/accent-insensitive text order, and the same order with embedded numbers
 * compared as numbers (`item2` before `item10`).
 *
 * Always sort through these, never `a.localeCompare(b, undefined, { … })`. V8
 * caches a collator for an OPTIONLESS `localeCompare` only; passing an options
 * object builds a fresh `Intl.Collator` on every comparison, which measured 60x
 * slower on Windows (a 110-label sort: 1.40 ms with options, 0.023 ms through a
 * collator built once). The chat pane sorts its model labels on every mount.
 */
const INSENSITIVE_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });
const NATURAL_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Same order as `localeCompare(b, undefined, { sensitivity: "base" })`. */
export function compareTextInsensitive(left: string, right: string): number {
  return INSENSITIVE_COLLATOR.compare(left, right);
}

/** Same order as `localeCompare(b, undefined, { sensitivity: "base", numeric: true })`. */
export function compareTextNatural(left: string, right: string): number {
  return NATURAL_COLLATOR.compare(left, right);
}
