/**
 * Cursor's REST API rejects any list request with `limit` above 100 with
 * `[validation_error] Limit must be at most 100`. Every call site that reaches
 * the Cursor SDK must clamp through here, and callers that want more rows must
 * page with `cursor` instead of asking for a bigger page.
 */
export const CURSOR_CLOUD_MAX_PAGE_LIMIT = 100;

/**
 * Clamp one page size into the range Cursor accepts.
 *
 * Returns `undefined` when the caller did not ask for a page size, so the SDK
 * keeps its own default instead of receiving a synthetic one.
 */
export function clampCursorCloudPageLimit(limit?: number | null): number | undefined {
  if (limit == null || !Number.isFinite(limit)) return undefined;
  const rounded = Math.floor(limit);
  if (rounded < 1) return 1;
  return Math.min(rounded, CURSOR_CLOUD_MAX_PAGE_LIMIT);
}
