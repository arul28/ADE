import { useEffect, useState } from "react";
import { normalizeGitRemoteIdentity } from "../../shared/crossMachineHandoff";
import type { CloudSavedChatRow } from "../../shared/cloudSavedChats";
import { accountProjectListUserId, onAccountProjectListAccountChange } from "./accountProjectListClient";

/**
 * The account's saved ADE Cloud chats (`GET /cloud/chats`), of one repository
 * or of the whole account: chats that happened, even when their computer is
 * asleep or deleted. One read per repository (or account) at most every 60 s,
 * shared by every page that asks.
 */
const READ_FLOOR_MS = 60_000;
type CacheEntry = { at: number; rows: readonly CloudSavedChatRow[]; reading: Promise<void> | null };
const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();

onAccountProjectListAccountChange(() => {
  cache.clear();
  for (const listener of listeners) listener();
});

function cacheKey(projectKey: string): string {
  return `${accountProjectListUserId() ?? ""}\0${projectKey}`;
}

/** The cache key part for "every repository". */
const WHOLE_ACCOUNT = "*";

function read(projectKey: string): void {
  const list = window.ade?.cloud?.savedChats?.list;
  if (typeof list !== "function") return;
  const key = cacheKey(projectKey);
  const entry = cache.get(key);
  if (entry?.reading || (entry && Date.now() - entry.at < READ_FLOOR_MS)) return;
  const next: CacheEntry = { at: Date.now(), rows: entry?.rows ?? [], reading: null };
  next.reading = list({ projectKey: projectKey === WHOLE_ACCOUNT ? null : projectKey, limit: 50 }).then(
    (answer) => {
      // No answer (nothing to ask yet): keep the rows, and let the next look read again.
      if (answer) next.rows = answer.chats;
      else next.at = 0;
    },
    () => {
      // A failed read keeps the last rows; the next page that asks tries again.
      next.at = 0;
    },
  ).finally(() => {
    next.reading = null;
    // An account change while it read: the answer is the last account's.
    if (cache.get(key) !== next) return;
    for (const listener of listeners) listener();
  });
  cache.set(key, next);
}

function useSavedChats(projectKey: string | null): readonly CloudSavedChatRow[] {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  // The key carries the account: an account known (or changed) after the
  // first read reads again under its own key.
  const key = projectKey ? cacheKey(projectKey) : null;
  useEffect(() => {
    if (!projectKey) return;
    read(projectKey);
    // Coming back to the window reads again (at most once a minute): a chat
    // saved from another device since then shows, and a failed read retries.
    const again = () => {
      if (document.visibilityState === "visible") read(projectKey);
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [key, projectKey]);
  return key ? cache.get(key)?.rows ?? [] : [];
}

/** One repository's saved chats (by its origin). */
export function useSavedChatsOfOrigin(origin: string | null): readonly CloudSavedChatRow[] {
  return useSavedChats(normalizeGitRemoteIdentity(origin));
}

/** The newest saved chats of every repository on the account. */
export function useAccountSavedChats(): readonly CloudSavedChatRow[] {
  return useSavedChats(WHOLE_ACCOUNT);
}
