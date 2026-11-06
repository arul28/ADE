/**
 * `16 MB`, `2.2 GB`: decimal units, as Google's download pages and the macOS
 * Finder print them. The desktop and the `ade android` CLI both use this, so a
 * size reads the same in the device picker and in a terminal.
 *
 * Each step starts where the step below would round to 1000, so a size never
 * reads `1000 MB` or `10.0 GB`.
 */
export function formatAndroidBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 999.5e6) {
    const gb = bytes / 1e9;
    return `${gb >= 9.95 ? Math.round(gb) : gb.toFixed(1)} GB`;
  }
  if (bytes >= 999.5e3) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
