/**
 * `16 MB`, `2.2 GB`: decimal units, as Google's download pages and the macOS
 * Finder print them. The desktop and the `ade android` CLI both use this, so a
 * size reads the same in the device picker and in a terminal.
 */
export function formatAndroidBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
