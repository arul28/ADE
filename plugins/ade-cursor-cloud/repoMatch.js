// Repo-key matching and the Cursor page ceilings.
//
// Ported verbatim in behaviour from ADE core so a plugin row and a core row
// agree on which agent belongs to which project:
//   apps/desktop/src/shared/cursorCloudRepoMatch.ts
//   apps/desktop/src/shared/cursorCloudApiLimits.ts
//
// Cursor's REST API refuses `limit` above 100 with
// `[validation_error] Limit must be at most 100`, so a caller that wants more
// rows pages with `cursor` instead of asking for a bigger page.

"use strict";

/** Cursor's per-page ceiling. A page size, never a row budget. */
const CURSOR_MAX_PAGE_LIMIT = 100;
/** Rows one fleet read walks, across as many pages as it takes. */
const FLEET_MAX_AGENTS = 200;
/** Rows a caller that named no budget gets. */
const FLEET_DEFAULT_AGENTS = 100;

/**
 * Normalize a git remote URL to a canonical `host/owner/repo` key so lane
 * remotes (`git@github.com:owner/repo.git`), project origins and Cursor repo
 * URLs (`https://github.com/owner/repo`) all compare equal.
 */
function repoMatchKey(url) {
  if (!url) return "";
  let s = String(url).trim();
  if (!s) return "";
  const sshMatch = s.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, "");
    s = s.replace(/^[^/@]+@/, "");
  }
  return s.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

/** `owner/repo` for a row's second line. Falls back to whatever it was given. */
function repoLabel(url) {
  const key = repoMatchKey(url);
  if (!key) return typeof url === "string" ? url : "";
  const parts = key.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : key;
}

/** Clamp one page size into the range Cursor accepts. */
function clampPageLimit(limit) {
  if (limit == null || !Number.isFinite(limit)) return undefined;
  const rounded = Math.floor(limit);
  if (rounded < 1) return 1;
  return Math.min(rounded, CURSOR_MAX_PAGE_LIMIT);
}

/** Clamp a whole-read row budget: at least one row, at most the fleet ceiling. */
function clampFleetBudget(limit) {
  const wanted = Number.isFinite(limit) ? Math.floor(Number(limit)) : FLEET_DEFAULT_AGENTS;
  return Math.min(Math.max(wanted, 1), FLEET_MAX_AGENTS);
}

module.exports = {
  CURSOR_MAX_PAGE_LIMIT,
  FLEET_MAX_AGENTS,
  FLEET_DEFAULT_AGENTS,
  repoMatchKey,
  repoLabel,
  clampPageLimit,
  clampFleetBudget,
};
