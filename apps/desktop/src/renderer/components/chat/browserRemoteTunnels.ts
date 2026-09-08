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

/* ── Approval policy ──────────────────────────────────────────────────────── */

/**
 * Which (machine, port) pairs a caller may reach, as a decision rather than a
 * tangle of React callbacks.
 *
 * The pinned machine already carries a machine-wide `portForward` grant, but
 * that grant is about the *machine*: a lane approved for a dev server on 3000
 * has not approved an admin console on 8080, and it is the *agent* that names
 * the port. So the first agent use of a port needs a person. A URL the human
 * typed does not — they just said it out loud by typing it.
 *
 * This lives here, next to the tab-tunnel reducer, so the rule is testable
 * without mounting a panel that positions a native browser view.
 */
export type TunnelApprovalState = {
  /** Answered "Allow once"; lives only as long as the pane does. */
  sessionApproved: ReadonlySet<string>;
  /** Answered "Always for this lane"; persisted with the rest of the view state. */
  alwaysKeys: readonly string[];
};

export type TunnelApprovalDecision = "allow" | "ask";

export function tunnelApprovalDecision(
  input: TunnelApprovalState & { key: string; human: boolean },
): TunnelApprovalDecision {
  if (input.human) return "allow";
  if (input.sessionApproved.has(input.key)) return "allow";
  return input.alwaysKeys.includes(input.key) ? "allow" : "ask";
}

export type TunnelApprovalAnswer = "once" | "always" | "deny";

/**
 * The state after a human (or a human-typed URL) answered.
 *
 * `"deny"` records nothing: a refusal is about this request, not a standing
 * rule, so the next one asks again. Identity-preserving when nothing changed,
 * so a repeat "Allow once" does not churn the persisted list.
 */
export function commitTunnelApproval(
  state: TunnelApprovalState,
  key: string,
  answer: TunnelApprovalAnswer,
): TunnelApprovalState {
  if (answer === "deny") return state;
  const sessionApproved = state.sessionApproved.has(key)
    ? state.sessionApproved
    : new Set([...state.sessionApproved, key]);
  if (answer === "once") {
    return sessionApproved === state.sessionApproved ? state : { ...state, sessionApproved };
  }
  const alwaysKeys = state.alwaysKeys.includes(key)
    ? state.alwaysKeys
    : [...state.alwaysKeys, key];
  if (sessionApproved === state.sessionApproved && alwaysKeys === state.alwaysKeys) return state;
  return { sessionApproved, alwaysKeys };
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
