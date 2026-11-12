// ---------------------------------------------------------------------------
// Deeplink target -> web-shell route. The inverse of `parseWebPath` in
// `./webRoutes`.
//
// Its own module because a settings target needs the settings manifest (with
// the MCP catalogue). The signed-out page parses links but never maps one to
// a route, so only the signed-in workspace imports this.
// ---------------------------------------------------------------------------

import { INVITE_SETTINGS_ENTRY_ID, type DeeplinkTarget } from "../../../shared/deeplinks";
import { openPlaceById } from "../../../shared/openPlaces";
import { settingsRouteFor } from "../../../shared/settingsManifest";

/** Map a deeplink target to the shared App route that renders it. */
export function targetToWebPath(target: DeeplinkTarget): string {
  const params = new URLSearchParams();
  switch (target.kind) {
    case "lane":
      params.set("laneId", target.laneId);
      return withQuery("/lanes", params);
    case "session":
      params.set("sessionId", target.sessionId);
      if (target.laneId) params.set("laneId", target.laneId);
      // Anchors: chat scrolled to an event, terminal restored to a byte offset.
      if (target.event != null) params.set("event", String(target.event));
      if (target.offset != null) params.set("offset", String(target.offset));
      return withQuery("/work", params);
    case "file":
      // Files tab opened at a path (and line), scoped to a lane worktree.
      params.set("path", target.path);
      if (target.line != null) params.set("line", String(target.line));
      if (target.laneId) params.set("laneId", target.laneId);
      return withQuery("/files", params);
    case "commit":
      // No standalone commit tab on web; the lane surface renders commit detail.
      params.set("commit", target.sha);
      if (target.laneId) params.set("laneId", target.laneId);
      return withQuery("/lanes", params);
    case "artifact":
      // Artifacts live under the Work surface (proof/artifacts drawer).
      params.set("artifact", target.artifactId);
      return withQuery("/work", params);
    case "pr":
      params.set("pr", String(target.prNumber));
      if (target.repoOwner) params.set("repoOwner", target.repoOwner);
      if (target.repoName) params.set("repoName", target.repoName);
      return withQuery("/prs", params);
    case "branch":
      params.set("repoOwner", target.repoOwner);
      params.set("repoName", target.repoName);
      params.set("branch", target.branch);
      if (target.prNumber) params.set("pr", String(target.prNumber));
      return withQuery("/lanes", params);
    case "linear-issue":
      params.set("linearIssue", target.issueIdentifier);
      if (target.branch) params.set("branch", target.branch);
      return withQuery("/work", params);
    case "settings":
      // The web client has one machine (the bound one), so `machineId` has
      // no page to pick here; an unknown id opens Settings itself.
      return settingsRouteFor(target.entryId);
    case "lane-share":
      params.set("grant", target.grantId);
      return withQuery("/shared", params);
    case "open": {
      const place = openPlaceById(target.place);
      return place?.target.kind === "route" ? place.target.route : "/work";
    }
    case "invite": {
      // Settings › Account, with the code for its box (`?invite=`), as on the desktop.
      const url = new URL(settingsRouteFor(INVITE_SETTINGS_ENTRY_ID), "https://ade.invalid");
      url.searchParams.set("invite", target.code);
      return `${url.pathname}${url.search}${url.hash}`;
    }
  }
}

/**
 * Absolute URL for a deeplink target on this deployment.
 *
 * `targetToWebPath` answers with a path the running App can push; opening a
 * SECOND tab needs a whole URL. The new tab boots the shell fresh, which
 * re-reads the route through `parseWebPath` and restores the machine/project
 * the first tab just connected — so the target survives the hop.
 */
export function targetToWebUrl(
  target: DeeplinkTarget,
  origin: string | null = typeof window === "undefined" ? null : window.location.origin,
): string {
  const path = targetToWebPath(target);
  if (!origin) return path;
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}

function withQuery(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
