/**
 * Projects added during first-run setup whose recent Claude Code and Codex
 * chats still need to come in as ADE chats.
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
};

type PendingChatImports = Record<string, PendingChatImport>;

function read(): PendingChatImports {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: PendingChatImports = {};
    for (const [rootPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<PendingChatImport> | null;
      if (entry && typeof entry.sinceMs === "number" && typeof entry.addedAt === "number") {
        out[rootPath] = { sinceMs: entry.sinceMs, addedAt: entry.addedAt };
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

export function queueChatImports(rootPaths: string[], sinceMs: number): void {
  if (!rootPaths.length) return;
  const next = read();
  const now = Date.now();
  for (const rootPath of rootPaths) next[rootPath] = { sinceMs, addedAt: now };
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
