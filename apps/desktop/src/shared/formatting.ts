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
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
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
