/**
 * Display helpers for external-session rows, shared by the desktop dialog and
 * the TUI. The import actions themselves live in `externalSessionPolicy.ts`.
 */

/**
 * Collapse the user's home directory to `~`, in the absence of an injected
 * abbreviator. `HOME` is not set on Windows — `USERPROFILE` is — and the two
 * sides of the comparison can disagree on separator AND on case (a cwd recorded
 * as `c:\users\me\dev\ade` against `USERPROFILE=C:\Users\me`), so both are
 * normalized and folded before matching. The slice runs against the ORIGINAL
 * string so the answer keeps the real casing.
 *
 * Folded unconditionally rather than per-platform like `pathComparisonKey`:
 * this module is shared with the sandboxed renderer, where `process.platform`
 * is not readable. The Linux cost is a cwd that differs from `$HOME` only by
 * case being abbreviated anyway — two such directories would have to both
 * exist, and the only consequence is a cosmetically wrong label in a row.
 */
function defaultAbbreviateHome(value: string): string {
  const rawHome =
    (typeof process !== "undefined"
      && (process.env?.HOME || process.env?.USERPROFILE))
    || (globalThis as { __ADE_HOME__?: string }).__ADE_HOME__
    || "";
  if (!rawHome) return value;
  const trimmedHome = rawHome.replace(/[\\/]+$/, "");
  const home = trimmedHome.replace(/\\/g, "/").toLowerCase();
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  if (normalized !== home && !normalized.startsWith(`${home}/`)) return value;
  return `~${value.slice(trimmedHome.length)}`;
}

export type ShortenExternalSessionCwdOptions = {
  /** Trailing path segments to keep. */
  maxSegments?: number;
  /**
   * How to collapse the home directory. The renderer passes
   * `renderer/lib/pathUtils.abbreviateHome` so there is one definition of what
   * `~` means; the default above covers the main process and the CLI.
   */
  abbreviateHome?: (value: string) => string;
};

/**
 * A path short enough to sit in a row without hiding the part that identifies
 * it — the repo folder at the end.
 *
 * Windows paths are the reason the separator is detected rather than assumed:
 * splitting `C:\Users\me\dev\ade` on "/" yields one segment, so the
 * "already short enough" check passed for every Windows path and the full
 * string went out untouched, to be clipped from the right by CSS instead.
 */
export function shortenExternalSessionCwd(
  cwd: string | null | undefined,
  options: ShortenExternalSessionCwdOptions = {},
): string {
  if (!cwd) return "its original folder";
  const maxSegments = options.maxSegments ?? 3;
  const abbreviate = options.abbreviateHome ?? defaultAbbreviateHome;

  const displayPath = abbreviate(cwd);
  // Read the separator off the original: `abbreviateHome` normalizes to "/"
  // when it matches, and a Windows path rejoined with "/" is still readable
  // but no longer copy-pasteable, and reads as a foreign OS.
  const separator = cwd.includes("\\") ? "\\" : "/";
  const segments = displayPath.split(/[\\/]/).filter(Boolean);
  if (segments.length <= maxSegments) return displayPath;
  return `…${separator}${segments.slice(-maxSegments).join(separator)}`;
}

/**
 * Transcript size for a row: whole units above 10 ("40 MB"), one decimal below
 * ("2.4 MB"). Empty when the host sent no size or a zero one — a 0 B session
 * says nothing worth a slot in the row.
 */
export function formatExternalSessionSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}
