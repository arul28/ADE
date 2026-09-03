/**
 * Where the canvas sends a reader, as `ade://` URLs.
 *
 * The compiled page navigated with `react-router-dom` — `navigate("/lanes?…")`,
 * `navigate("/prs?…")` — because it WAS the app's renderer. A guest has no
 * router and no route table; it asks the host to go somewhere, and the host
 * decides whether that means a tab switch, a new window or nothing at all.
 *
 * Every URL minted here is one `shared/deeplinks.ts` already parses on the
 * shipped host, so this is a translation and not a new surface. Two compiled
 * navigations have no deeplink to translate INTO and are narrowed instead —
 * `/prs?tab=integration&proposalId=…` and `/lanes?…&action=manage`; both are
 * written up in PARITY.md rather than minted as URLs the host would refuse.
 */

/** The Lanes tab, focused on one lane. Was `navigate("/lanes?laneId=…")`. */
export function laneDeeplink(laneId: string): string {
  return `ade://lane/${encodeURIComponent(laneId)}`;
}

/** One PR, by its GitHub coordinates. Was `navigate("/prs?prId=…")`. */
export function prDeeplink(owner: string, repo: string, number: number): string {
  return `ade://pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;
}

/**
 * This plugin's own graph page, focused on one lane.
 *
 * `ade://plugin/<pluginId>/<panelId>?ctx=<json>` is the only plugin-navigation
 * shape the parser accepts, and the panel id is the surface's `panelId` rather
 * than its surface id — which is why the manifest keeps `panelId: "graph"` on
 * the webview surface and not only as the fallback.
 */
export function graphFocusDeeplink(laneId: string): string {
  const ctx = JSON.stringify({ focusLane: laneId });
  return `ade://plugin/ade-graph/graph?ctx=${encodeURIComponent(ctx)}`;
}
