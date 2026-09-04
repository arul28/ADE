/**
 * Where History sends a reader, as `ade://` URLs.
 *
 * The compiled page navigated with `react-router-dom` because it WAS the app's
 * renderer. A guest has no router; it asks the host to go somewhere.
 *
 * Every URL minted here is one `shared/deeplinks.ts` already parses. Two
 * compiled navigations have no deeplink to translate INTO — `/prs` (no owner /
 * repo / number) and `/lanes?…&focus=single` (the Lanes git pane). Both are
 * written up in PARITY.md. The second is `ade://commit/<sha>?lane=<id>` instead,
 * which is the shipped commit target rather than a renderer query the host
 * would refuse.
 */

export function laneDeeplink(laneId: string): string {
  return `ade://lane/${encodeURIComponent(laneId)}`;
}

export function commitDeeplink(sha: string, laneId?: string | null): string {
  const query = new URLSearchParams();
  if (laneId) query.set("lane", laneId);
  const suffix = query.toString();
  return `ade://commit/${encodeURIComponent(sha)}${suffix ? `?${suffix}` : ""}`;
}

/**
 * This plugin's own History page, focused on a surface / lane / commit / event.
 *
 * `ade://plugin/<pluginId>/<panelId>?ctx=<json>` is the only plugin-navigation
 * shape the parser accepts, and `ctx` is the only query key that route passes
 * through — so the focus rides inside it rather than as query params the host
 * would drop in silence.
 */
export function historyFocusDeeplink(args: {
  panelId: "commits" | "activity";
  laneId?: string | null;
  commitSha?: string | null;
  eventId?: string | null;
}): string {
  const ctx: Record<string, string> = {};
  if (args.laneId) ctx.laneId = args.laneId;
  if (args.commitSha) ctx.commitSha = args.commitSha;
  if (args.eventId) ctx.eventId = args.eventId;
  const query = Object.keys(ctx).length > 0
    ? `?ctx=${encodeURIComponent(JSON.stringify(ctx))}`
    : "";
  return `ade://plugin/ade-history/${args.panelId}${query}`;
}

/**
 * Translate a compiled renderer path into a deeplink, or null when the path is
 * this page talking to itself (a `/history?…` focus) or has no shipped target.
 */
export function pathToDeeplink(path: string): string | null {
  const url = new URL(path, "https://ade.invalid");
  const route = url.pathname;
  if (route === "/lanes" || route.startsWith("/lanes")) {
    const laneId = url.searchParams.get("laneId");
    const commitSha = url.searchParams.get("commitSha");
    if (commitSha) return commitDeeplink(commitSha, laneId);
    if (laneId) return laneDeeplink(laneId);
    return null;
  }
  if (route === "/work") {
    const laneId = url.searchParams.get("laneId");
    return laneId ? laneDeeplink(laneId) : null;
  }
  if (route === "/history") return null;
  if (route === "/prs") return null;
  return null;
}
