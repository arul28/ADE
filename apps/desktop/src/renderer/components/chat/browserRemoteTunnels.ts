import {
  displayUrlForTunnel,
  urlBelongsToTunnel,
  type RemoteLoopbackTunnel,
} from "../../../shared/remoteLoopbackUrl";

/**
 * Per-tab memory of "this tab is really looking at another machine".
 *
 * The browser loads `http://127.0.0.1:<ephemeral>`, but nobody asked for that:
 * the human typed (or the agent asked for) `http://localhost:3000` on the
 * pinned machine. Every surface that shows a URL — the URL bar, the tab title,
 * the observation an agent reads back — has to show what was asked for, or the
 * next thing anyone does with that URL is wrong.
 */
export type TabTunnelEntry = {
  tunnel: RemoteLoopbackTunnel;
  /** When the mapping was recorded, for the load-in-flight grace below. */
  armedAt: number;
};

export type TabTunnelMap = Record<string, TabTunnelEntry>;

export type TabUrlSnapshot = { id: string; url?: string | null };

/**
 * How long a freshly-armed mapping survives a tab URL that does not match it.
 *
 * A mapping is recorded when the navigation is issued, but the tab keeps
 * reporting the *previous* page until the new one commits. Without this grace
 * the very first status event after `navigate` would drop the mapping and the
 * URL bar would fall back to the raw forward port.
 */
export const TAB_TUNNEL_ARM_GRACE_MS = 15_000;

/**
 * Drop mappings for tabs that closed or navigated off the tunnel.
 *
 * Staying on the same local origin is still tunneled (a client-side route
 * change, a link within the dev server), so the mapping survives. Leaving for a
 * real site does not: that page is genuinely this desktop's, and continuing to
 * relabel it as the remote machine's would be a lie.
 */
export function reconcileTabTunnels(
  current: TabTunnelMap,
  tabs: readonly TabUrlSnapshot[],
  now: number = Date.now(),
): TabTunnelMap {
  const next: TabTunnelMap = {};
  const seen = new Set<string>();
  for (const tab of tabs) {
    seen.add(tab.id);
    const entry = current[tab.id];
    if (!entry) continue;
    // A tab mid-navigation reports no URL yet, or still the previous one.
    const url = typeof tab.url === "string" ? tab.url.trim() : "";
    const settled = now - entry.armedAt > TAB_TUNNEL_ARM_GRACE_MS;
    if (url && settled && !urlBelongsToTunnel(url, entry.tunnel)) continue;
    next[tab.id] = entry;
  }
  const currentKeys = Object.keys(current);
  if (currentKeys.length === Object.keys(next).length
    && currentKeys.every((key) => next[key] === current[key])) {
    return current;
  }
  return next;
}

/** Record (or replace) the tunnel a tab is now showing. */
export function setTabTunnel(
  current: TabTunnelMap,
  tabId: string | null | undefined,
  tunnel: RemoteLoopbackTunnel | null,
  now: number = Date.now(),
): TabTunnelMap {
  const id = (tabId ?? "").trim();
  if (!id) return current;
  if (!tunnel) {
    if (!(id in current)) return current;
    const next = { ...current };
    delete next[id];
    return next;
  }
  return { ...current, [id]: { tunnel, armedAt: now } };
}

/** The URL to show for a tab: the remote origin when tunneled, else as-is. */
export function tunnelAwareUrl(
  url: string | null | undefined,
  entry: TabTunnelEntry | null | undefined,
): string {
  const text = (url ?? "").trim();
  if (!entry) return text;
  return displayUrlForTunnel(text, entry.tunnel) ?? text;
}
