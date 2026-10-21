/**
 * Projects added during first-run setup whose recent coding-agent
 * chats are still to be offered for import (a suggestion card on first open).
 *
 * Importing a chat needs the project open (its lanes, its chat service), so
 * setup records the wish here and `useOnboardingChatImport` carries it out the
 * first time each project opens on this computer. Per computer, like the rest
 * of onboarding: a project added on one machine imports that machine's chats.
 */

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

function read(): PendingChatImports {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: PendingChatImports = {};
    for (const [rootPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<PendingChatImport> | null;
      if (entry && typeof entry.sinceMs === "number" && typeof entry.addedAt === "number") {
        const excludedKeys = Array.isArray(entry.excludedKeys)
          ? entry.excludedKeys.filter((key): key is string => typeof key === "string")
          : [];
        out[rootPath] = {
          sinceMs: entry.sinceMs,
          addedAt: entry.addedAt,
          ...(excludedKeys.length ? { excludedKeys } : null),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function write(next: PendingChatImports): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the chats stay importable from Work's import browser.
  }
}

export function queueChatImports(
  entries: ReadonlyArray<{ rootPath: string; excludedKeys?: Iterable<string> | null }>,
  sinceMs: number,
): void {
  if (!entries.length) return;
  const next = read();
  const now = Date.now();
  for (const { rootPath, excludedKeys } of entries) {
    const excluded = excludedKeys ? [...excludedKeys] : [];
    next[rootPath] = { sinceMs, addedAt: now, ...(excluded.length ? { excludedKeys: excluded } : null) };
  }
  write(next);
}

export function pendingChatImportFor(rootPath: string): PendingChatImport | null {
  return read()[rootPath] ?? null;
}

export function clearPendingChatImport(rootPath: string): void {
  const next = read();
  if (!(rootPath in next)) return;
  delete next[rootPath];
  write(next);
}
