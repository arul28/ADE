/**
 * The chat last open on the Chats page, per machine scope (the page's
 * `targetKey`: "local-machine", a remote binding's key, or a web machine).
 *
 * The page's route unmounts when you leave it, and the window can restart, so
 * the choice lives in localStorage. `null` is the new-chat draft: the user
 * pressed New chat, or the scope has never been opened.
 */
const STORAGE_KEY = "ade.chats.lastOpenChat.v1";
/** Machines come and go; a handful of scopes is plenty. */
const MAX_SCOPES = 24;

type Stored = Record<string, string | null>;

function readAll(): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[scope] = value;
      else if (value === null) out[scope] = null;
    }
    return out;
  } catch {
    return {};
  }
}

/** The chat to reopen for `scopeKey`: its id, or `null` for the new-chat draft. */
export function readLastOpenChat(scopeKey: string): string | null {
  return readAll()[scopeKey] ?? null;
}

export function rememberLastOpenChat(scopeKey: string, sessionId: string | null): void {
  const all = readAll();
  if (Object.prototype.hasOwnProperty.call(all, scopeKey) && all[scopeKey] === sessionId) return;
  // Re-insert so the most recent scope is last; the oldest fall off the front.
  delete all[scopeKey];
  all[scopeKey] = sessionId;
  const scopes = Object.keys(all);
  for (const stale of scopes.slice(0, Math.max(0, scopes.length - MAX_SCOPES))) delete all[stale];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or unavailable: the page still works, it just forgets.
  }
}
