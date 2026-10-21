/**
 * Projects added during first-run setup whose recent coding-agent
 * chats are still to be offered for import (a suggestion card on first open).
 *
 * Importing a chat needs the project open (its lanes, its chat service), so
 * setup records the wish here and `useOnboardingChatImport` carries it out the
 * first time each project opens on this computer. Per computer, like the rest
 * of onboarding: a project added on one machine imports that machine's chats.
 */

import { normalizePathForComparison } from "../lib/pathUtils";
import { createLocalStore, finiteNumber, storedRecord } from "./localStore";

const STORAGE_KEY = "ade.onboarding.pendingChatImports.v1";

export type PendingChatImport = {
  /** Import chats active at or after this time. */
  sinceMs: number;
  addedAt: number;
  /**
   * Chats the user left out in setup's picker, as `chatImportKey`s. Absent
   * (every entry stored before the picker existed) means none: every chat in
   * the window comes in. A list of what to leave out, not what to bring, so a
   * chat that starts after setup still comes in with its project.
   */
  excludedKeys?: string[];
};

/** How setup and the import name one chat: the importer's own provider + session id. */
export function chatImportKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

type PendingChatImports = Record<string, PendingChatImport>;

function parseEntries(stored: unknown): PendingChatImports {
  const out: PendingChatImports = {};
  for (const [rootPath, value] of Object.entries(storedRecord(stored) ?? {})) {
    const entry = storedRecord(value);
    if (!entry) continue;
    const sinceMs = finiteNumber(entry.sinceMs);
    const addedAt = finiteNumber(entry.addedAt);
    if (sinceMs === undefined || addedAt === undefined) continue;
    const excludedKeys = Array.isArray(entry.excludedKeys)
      ? entry.excludedKeys.filter((key): key is string => typeof key === "string")
      : [];
    out[rootPath] = { sinceMs, addedAt, ...(excludedKeys.length ? { excludedKeys } : null) };
  }
  return out;
}

/** When storage is unavailable the list holds for this session; the chats stay importable from Work's import browser. */
const store = createLocalStore({ key: STORAGE_KEY, event: "ade:pending-chat-imports", parse: parseEntries });

/**
 * The stored key that names the same folder as `rootPath`, if any. Roots are
 * compared as paths (separators, a trailing slash, a Windows drive's case), so
 * a project that opens under a differently written root still finds its entry.
 */
function keyFor(entries: PendingChatImports, rootPath: string): string | null {
  if (rootPath in entries) return rootPath;
  const wanted = normalizePathForComparison(rootPath);
  return Object.keys(entries).find((key) => normalizePathForComparison(key) === wanted) ?? null;
}

export function queueChatImports(
  entries: ReadonlyArray<{ rootPath: string; excludedKeys?: Iterable<string> | null }>,
  sinceMs: number,
): void {
  if (!entries.length) return;
  const next = { ...store.get() };
  const now = Date.now();
  for (const { rootPath, excludedKeys } of entries) {
    const excluded = excludedKeys ? [...excludedKeys] : [];
    const existing = keyFor(next, rootPath);
    if (existing !== null) delete next[existing];
    next[rootPath] = { sinceMs, addedAt: now, ...(excluded.length ? { excludedKeys: excluded } : null) };
  }
  store.set(next);
}

export function pendingChatImportFor(rootPath: string): PendingChatImport | null {
  const entries = store.get();
  const key = keyFor(entries, rootPath);
  return key === null ? null : entries[key] ?? null;
}

export function clearPendingChatImport(rootPath: string): void {
  const current = store.get();
  const key = keyFor(current, rootPath);
  if (key === null) return;
  const next = { ...current };
  delete next[key];
  store.set(next);
}
