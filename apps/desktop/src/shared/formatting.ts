/** `1 tool`, `2 tools`, `0 files`; pass `many` when the plural is not `noun` + "s". */
export function pluralCount(count: number, noun: string, many: string = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/**
 * Format a byte count into a short human-readable size (e.g. "1.4 GB").
 * `base` is the bytes to a KB: 1024 by default, 1000 for a disk size on a
 * machine whose file manager counts that way (see `formatStorageBytes`).
 */
export function formatBytes(bytes: number, base: 1000 | 1024 = 1024): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  // Round first, then pick the unit: just under 1 MB is "1.0 MB", never "1024 KB".
  const digitsFor = (amount: number, index: number) => (index === 0 || amount >= 100 ? 0 : 1);
  while (unit < units.length - 1 && Number(value.toFixed(digitsFor(value, unit))) >= base) {
    value /= base;
    unit += 1;
  }
  return `${value.toFixed(digitsFor(value, unit))} ${units[unit]}`;
}

/**
 * A disk size as the measured machine's own file manager would print it, so
 * ADE's "free on disk" matches Finder on a Mac and Explorer on Windows: Finder
 * and the Linux file managers use 1000 bytes to the KB, Windows Explorer uses
 * 1024 and still prints "GB". `platform` is the measured machine's
 * `process.platform`; unknown (an older snapshot) keeps 1024. Only for storage
 * figures; other sizes keep `formatBytes`.
 */
export function formatStorageBytes(bytes: number, platform: string | null | undefined): string {
  // A Node platform ("darwin", "linux", "win32") or a machine tile's word ("mac", "linux", "windows").
  return formatBytes(bytes, platform === "darwin" || platform === "mac" || platform === "linux" ? 1000 : 1024);
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
// Built at the first comparison, not when the module loads: the first
// collator loads ICU's collation data (4.8 ms in a Node measure), and this module is on the
// boot path of main and the renderer, which often compare nothing yet.
let insensitiveCollator: Intl.Collator | null = null;
let naturalCollator: Intl.Collator | null = null;

/** Same order as `localeCompare(b, undefined, { sensitivity: "base" })`. */
export function compareTextInsensitive(left: string, right: string): number {
  insensitiveCollator ??= new Intl.Collator(undefined, { sensitivity: "base" });
  return insensitiveCollator.compare(left, right);
}

/** Same order as `localeCompare(b, undefined, { sensitivity: "base", numeric: true })`. */
export function compareTextNatural(left: string, right: string): number {
  naturalCollator ??= new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return naturalCollator.compare(left, right);
}

/** Megabytes as gigabytes for a sentence: "20", "1.5". Whole numbers from 10 GB up. */
export function formatGb(mb: number): string {
  const value = mb / 1024;
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, "");
}

/**
 * A Date shifted so its UTC fields read the current zone's wall clock. A
 * formatter pinned to `timeZone: "UTC"` then prints local time while still
 * following a system time-zone change; one built without a zone would keep
 * the zone it was constructed in for as long as it is cached.
 */
export function wallClockAsUtc(date: Date): Date {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
}
