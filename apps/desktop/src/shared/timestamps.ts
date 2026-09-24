/** Parse a timestamp to milliseconds, returning null for missing or invalid input. */
export function parseTimestampMs(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}
