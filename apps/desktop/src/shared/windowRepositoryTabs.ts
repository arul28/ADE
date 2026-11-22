import type { RemoteOpenProjectBinding } from "./types";

/**
 * A window's repository tabs as main keeps and saves them (S5, spec 5.1).
 *
 * A tab is identified by its repository (`id`: the account project id,
 * `repo:<origin>` or the folder of a repository with no origin), not by a
 * folder. `copy` is the copy the tab showed: a local folder, a remote
 * project, or null for a tab with no computer online. On a restore the tab
 * comes back under its id; the copy is where it opens first.
 */
export type SavedRepositoryTabCopy =
  | { kind: "local"; rootPath: string }
  | { kind: "remote"; binding: RemoteOpenProjectBinding };

export type SavedRepositoryTab = {
  id: string;
  displayName: string;
  copy: SavedRepositoryTabCopy | null;
};

export type SavedWindowRepositoryTabs = {
  tabs: SavedRepositoryTab[];
  /** The tab in front; null for Home or a new tab. */
  activeId: string | null;
  updatedAt?: string;
};

/** More tabs than this is not a strip a person keeps; the rest is dropped. */
export const MAX_SAVED_REPOSITORY_TABS = 64;
const MAX_TEXT = 4096;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_TEXT ? trimmed : null;
}

/**
 * Rebuilds a saved strip field by field. `parseRemote` is the caller's own
 * parser for a remote binding (main recomputes the key). Tabs with a bad id
 * and repeated ids are dropped; an active id that names no tab becomes null.
 */
export function coerceSavedWindowRepositoryTabs(
  value: unknown,
  parseRemote: (value: unknown) => RemoteOpenProjectBinding | null,
): SavedWindowRepositoryTabs | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.tabs)) return null;
  const tabs: SavedRepositoryTab[] = [];
  const seen = new Set<string>();
  for (const entry of row.tabs) {
    if (tabs.length >= MAX_SAVED_REPOSITORY_TABS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const tab = entry as Record<string, unknown>;
    const id = text(tab.id);
    if (!id || seen.has(id)) continue;
    let copy: SavedRepositoryTabCopy | null = null;
    const rawCopy = tab.copy as Record<string, unknown> | null | undefined;
    if (rawCopy && typeof rawCopy === "object") {
      if (rawCopy.kind === "local") {
        const rootPath = text(rawCopy.rootPath);
        if (rootPath) copy = { kind: "local", rootPath };
      } else if (rawCopy.kind === "remote") {
        const binding = parseRemote(rawCopy.binding);
        if (binding) copy = { kind: "remote", binding: { ...binding, iconDataUrl: null } };
      }
    }
    seen.add(id);
    tabs.push({ id, displayName: text(tab.displayName) ?? id, copy });
  }
  const activeId = text(row.activeId);
  return {
    tabs,
    activeId: activeId && seen.has(activeId) ? activeId : null,
    ...(text(row.updatedAt) ? { updatedAt: text(row.updatedAt)! } : {}),
  };
}

/** The tab-order key of a saved copy: the local folder or the remote binding key. */
export function savedRepositoryCopyKey(copy: SavedRepositoryTabCopy | null): string | null {
  if (!copy) return null;
  return copy.kind === "local" ? copy.rootPath : copy.binding.key;
}
