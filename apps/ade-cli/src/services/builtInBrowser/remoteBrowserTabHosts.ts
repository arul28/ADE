/**
 * Which machine's browser holds each tab an agent has seen.
 *
 * The forwarder keeps one task on one machine with this: every tab and
 * browser-session id a result names is remembered with the browser it came
 * from, and a later command for that id goes there. A command with no tab
 * named goes where the chat's last tab is. In memory only: after a restart an
 * unknown id is looked up on every machine (`listTabsForAgent`).
 */

/** The browser a tab, a browser session or a command lives in. */
export type BrowserHost =
  | { kind: "here" }
  | { kind: "desktop"; clientId: string; label: string };

export const HERE: BrowserHost = { kind: "here" };

/** Tab and browser-session ids whose machine this daemon remembers. */
const TAB_HOST_CAP = 2_000;
/** Chats whose last tab this daemon remembers. */
const CHAT_CAP = 200;

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Set `key` as the newest entry of `map`, and drop the oldest past `cap`. */
export function rememberNewest<Value>(map: Map<string, Value>, key: string, value: Value, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export type TabHostMemory = ReturnType<typeof createTabHostMemory>;

export function createTabHostMemory() {
  const tabHosts = new Map<string, BrowserHost>();
  const sessionHosts = new Map<string, BrowserHost>();
  /** Chat → the tab its last command acted on. */
  const chatLastTab = new Map<string, string>();

  function rememberTab(tabId: unknown, host: BrowserHost): void {
    const id = stringOrNull(tabId);
    if (id) rememberNewest(tabHosts, id, host, TAB_HOST_CAP);
  }

  /** Remember which browser holds every tab and browser session a result names. */
  function noteResult(result: unknown, host: BrowserHost, depth = 0): void {
    if (!isRecord(result) || depth > 2) return;
    if (Array.isArray(result.tabs)) {
      for (const tab of result.tabs) if (isRecord(tab)) rememberTab(tab.id, host);
    }
    rememberTab(result.targetTabId, host);
    const noteSession = (session: unknown) => {
      if (!isRecord(session)) return;
      const id = stringOrNull(session.id);
      if (id) rememberNewest(sessionHosts, id, host, TAB_HOST_CAP);
      rememberTab(session.tabId, host);
    };
    noteSession(result.session);
    if (Array.isArray(result.sessions)) result.sessions.forEach(noteSession);
    if (isRecord(result.observation)) rememberTab(result.observation.tabId, host);
    if (isRecord(result.status)) noteResult(result.status, host, depth + 1);
    const closed = isRecord(result.closedTab) ? stringOrNull(result.closedTab.id) : null;
    if (closed) tabHosts.delete(closed);
  }

  /** The tab a chat's command acted on, from the tab it named and its result. */
  function noteChatTab(chatSessionId: string | null, namedTabId: unknown, result: unknown): void {
    if (!chatSessionId) return;
    const record = isRecord(result) ? result : {};
    const closed = isRecord(record.closedTab) ? stringOrNull(record.closedTab.id) : null;
    if (closed && chatLastTab.get(chatSessionId) === closed) {
      chatLastTab.delete(chatSessionId);
      return;
    }
    const tabId = stringOrNull(record.targetTabId)
      ?? (isRecord(record.observation) ? stringOrNull(record.observation.tabId) : null)
      ?? (isRecord(record.session) ? stringOrNull(record.session.tabId) : null)
      ?? (closed ? null : stringOrNull(namedTabId));
    if (tabId) rememberNewest(chatLastTab, chatSessionId, tabId, CHAT_CAP);
  }

  return {
    noteResult,
    noteChatTab,
    /** The browser holding a tab or browser session, when known. */
    hostOf: (ids: { tabId: string | null; sessionId: string | null }): BrowserHost | null =>
      (ids.tabId ? tabHosts.get(ids.tabId) : null) ?? (ids.sessionId ? sessionHosts.get(ids.sessionId) : null) ?? null,
    /** The tab a chat last acted on, when known. */
    lastTabOf: (chatSessionId: string | null): string | null =>
      chatSessionId ? chatLastTab.get(chatSessionId) ?? null : null,
  };
}
