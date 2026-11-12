import { LANE_SHARE_GRANT_ID_PATTERN } from "../../../shared/laneShareDirectory";
// ---------------------------------------------------------------------------
// Web-shell route mapping.
//
// A THIN layer over the shared deeplink grammar (`../../../shared/deeplinks`).
// It never re-implements parsing: the `/open?...` pre-App URL is normalised to
// the canonical HTTPS deeplink form and handed to `parseDeeplink`, so any
// grammar additions made upstream flow through automatically.
//
// This module reads routes: parseOpenTarget (the `/open` URL) and
// parseWebPath (a live app route back to its deeplink target). The other
// direction, target -> route, is in `./webTargetPaths`. It needs the settings
// manifest, so it stays out of the signed-out page; only the signed-in
// workspace loads it.
//
// parseWebPath and targetToWebPath are inverses for lane / session / pr /
// branch / linear-issue, which the unit tests round-trip.
// ---------------------------------------------------------------------------

import {
  ADE_DEEPLINK_HTTPS_BASE_URL,
  parseDeeplink,
  type DeeplinkTarget,
} from "../../../shared/deeplinks";

// A base only used to give relative paths a parseable origin; never emitted.
const DUMMY_ORIGIN = "https://web-shell.invalid";

/**
 * Parse the pre-App `/open` URL (or its raw query string) into a deeplink
 * target. The hosted web client lives on `app.ade-app.dev`, which is not the
 * canonical deeplink host, so we rebuild the canonical HTTPS URL from the query
 * and defer entirely to the shared parser.
 */
export function parseOpenTarget(searchOrUrl: string): DeeplinkTarget | null {
  let search = searchOrUrl;
  if (/^https?:\/\//i.test(searchOrUrl) || searchOrUrl.startsWith("/")) {
    try {
      search = new URL(searchOrUrl, DUMMY_ORIGIN).search;
    } catch {
      return null;
    }
  }
  const normalized = search.startsWith("?") ? search : search ? `?${search}` : "";
  if (!normalized) return null;
  const result = parseDeeplink(`${ADE_DEEPLINK_HTTPS_BASE_URL}${normalized}`);
  return result.ok ? result.target : null;
}

/**
 * Map a live App route (path + query) back to a deeplink target, or null when
 * the route carries no addressable target. Distinguishing params keep the
 * mapping unambiguous and make it the inverse of `targetToWebPath`.
 */
export function parseWebPath(pathAndQuery: string): DeeplinkTarget | null {
  let url: URL;
  try {
    url = new URL(pathAndQuery, DUMMY_ORIGIN);
  } catch {
    return null;
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const params = url.searchParams;

  if (pathname === "/lanes") {
    const branch = params.get("branch");
    if (branch) {
      const repoOwner = params.get("repoOwner");
      const repoName = params.get("repoName");
      if (!repoOwner || !repoName) return null;
      const prNumber = parsePositiveInt(params.get("pr"));
      return {
        kind: "branch",
        repoOwner,
        repoName,
        branch,
        ...(prNumber ? { prNumber } : {}),
      };
    }
    const laneId = params.get("laneId");
    return laneId ? { kind: "lane", laneId } : null;
  }

  if (pathname === "/files") {
    const path = params.get("path");
    if (!path) return null;
    const line = parsePositiveInt(params.get("line"));
    const laneId = params.get("laneId");
    return {
      kind: "file",
      path,
      ...(line ? { line } : {}),
      ...(laneId ? { laneId } : {}),
    };
  }

  if (pathname === "/work") {
    const sessionId = params.get("sessionId");
    if (sessionId) {
      const laneId = params.get("laneId");
      const event = parseNonNegativeInt(params.get("event"));
      const offset = parseNonNegativeInt(params.get("offset"));
      return {
        kind: "session",
        sessionId,
        ...(laneId ? { laneId } : {}),
        ...(event != null ? { event } : {}),
        ...(offset != null ? { offset } : {}),
      };
    }
    const issueIdentifier = params.get("linearIssue");
    if (issueIdentifier) {
      const branch = params.get("branch");
      return { kind: "linear-issue", issueIdentifier, ...(branch ? { branch } : {}) };
    }
    return null;
  }

  if (pathname === "/shared") {
    const grantId = params.get("grant");
    return grantId && LANE_SHARE_GRANT_ID_PATTERN.test(grantId) ? { kind: "lane-share", grantId } : null;
  }

  if (pathname === "/prs") {
    const prNumber = parsePositiveInt(params.get("pr"));
    const repoOwner = params.get("repoOwner");
    const repoName = params.get("repoName");
    if (prNumber && repoOwner && repoName) {
      return { kind: "pr", prNumber, repoOwner, repoName };
    }
    return null;
  }

  return null;
}

function parsePositiveInt(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function parseNonNegativeInt(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
