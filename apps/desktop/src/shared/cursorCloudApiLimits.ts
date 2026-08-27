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

/**
 * The total number of agent rows one fleet read walks, across as many Cursor
 * pages of `CURSOR_CLOUD_MAX_PAGE_LIMIT` as it takes. This is a row budget, not
 * a page size.
 *
 * Every client sends this same explicit value so the fleet a reader sees does
 * not depend on which client asked. iOS mirrors it in
 * `apps/ios/ADE/Views/CursorCloud/CursorCloudModels.swift`
 * (`CursorCloudFleetRequest.maxAgents`).
 */
export const CURSOR_CLOUD_FLEET_MAX_AGENTS = 200;

/**
 * The row budget the host applies when a caller sends no `limit`. Kept only for
 * older clients; every current client sends `CURSOR_CLOUD_FLEET_MAX_AGENTS`.
 */
export const CURSOR_CLOUD_FLEET_DEFAULT_AGENTS = 100;
