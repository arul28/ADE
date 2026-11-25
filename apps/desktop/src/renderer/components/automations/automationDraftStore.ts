/**
 * The one unsaved automation draft per repository, kept in this window's local
 * storage so it survives leaving the Automations tab, a project switch, the
 * tab moving to another copy, and an app or brain restart. Save and Discard
 * clear it.
 *
 * It is per repository and per computer: a draft is a person's unfinished
 * edit, not project data, so it never syncs. The target machine is stored by
 * id and matched again on restore; a machine that has gone keeps the draft but
 * asks for a machine again.
 */

import type { AutomationRuleDraft } from "../../../shared/types";
import type { RepositoryTab } from "../../../shared/repositoryTab";

const STORAGE_KEY_PREFIX = "ade.automations.draft.v1";

export type StoredAutomationDraft = {
  version: 2;
  draft: AutomationRuleDraft;
  /** The snapshot the draft is compared with: the saved rule, or the blank or template start. */
  savedSnapshot: string;
  /** The rule key being edited, or null for a new automation. */
  ruleKey: string | null;
  /** The machine the draft targets; null means the tab's own machine. */
  targetMachineId: string | null;
  machineChosen: boolean;
  /** "Runs on: ADE Cloud" was picked and not saved yet. */
  cloudChosen: boolean;
  /** "Runs on" was picked for a rule that follows the account, as a change of home. */
  rehomeChosen: boolean;
  savedAt: string;
};

export type StoredAutomationDraftEntry = Omit<StoredAutomationDraft, "version" | "savedAt">;

/**
 * Where a repository's draft is stored. `key` is written; `aliases` are read
 * (and removed) too, so a draft survives the tab's id settling (an origin
 * address becomes the account project once the list loads) and drafts saved
 * under a copy's folder path before the tab was the repository.
 */
export type AutomationDraftScope = { key: string; aliases: string[] };

export function automationDraftScope(tab: RepositoryTab | null, copyRootPath: string | null): AutomationDraftScope | null {
  const root = copyRootPath?.trim() || null;
  const key = tab?.id ?? root;
  if (!key) return null;
  const aliases = new Set<string>([
    ...(tab?.kind === "account" ? tab.repoKeys : []),
    ...(root ? [root] : []),
  ]);
  aliases.delete(key);
  return { key, aliases: [...aliases] };
}

function storageKey(scopeKey: string): string {
  return `${STORAGE_KEY_PREFIX}::${scopeKey}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function parseStored(raw: string): StoredAutomationDraft | null {
  const parsed = JSON.parse(raw) as Partial<Omit<StoredAutomationDraft, "version">> & { version?: number };
  const draft = parsed?.draft as Partial<AutomationRuleDraft> | undefined;
  if (
    (parsed?.version !== 1 && parsed?.version !== 2)
    || !draft || typeof draft !== "object" || !Array.isArray(draft.triggers)
    || typeof parsed.savedSnapshot !== "string"
  ) {
    return null;
  }
  return {
    version: 2,
    draft: draft as AutomationRuleDraft,
    savedSnapshot: parsed.savedSnapshot,
    ruleKey: typeof parsed.ruleKey === "string" && parsed.ruleKey ? parsed.ruleKey : null,
    targetMachineId: typeof parsed.targetMachineId === "string" && parsed.targetMachineId ? parsed.targetMachineId : null,
    machineChosen: parsed.machineChosen !== false,
    cloudChosen: parsed.cloudChosen === true,
    rehomeChosen: parsed.rehomeChosen === true,
    savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
  };
}

/** The newest usable draft under the scope's key or any alias; unusable records are removed. */
export function loadStoredAutomationDraft(scope: AutomationDraftScope | null): StoredAutomationDraft | null {
  if (!scope) return null;
  const store = storage();
  if (!store) return null;
  let newest: StoredAutomationDraft | null = null;
  for (const scopeKey of [scope.key, ...scope.aliases]) {
    try {
      const raw = store.getItem(storageKey(scopeKey));
      if (!raw) continue;
      const stored = parseStored(raw);
      if (!stored) {
        // A record this window cannot use would fail again on every restore.
        store.removeItem(storageKey(scopeKey));
        continue;
      }
      if (!newest || stored.savedAt > newest.savedAt) newest = stored;
    } catch {
      // Unreadable: skip it.
    }
  }
  return newest;
}

export function storeAutomationDraft(scope: AutomationDraftScope | null, entry: StoredAutomationDraftEntry): void {
  if (!scope) return;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(storageKey(scope.key), JSON.stringify({ ...entry, version: 2, savedAt: new Date().toISOString() }));
    // One draft per repository: the copy under an old key is now stale.
    for (const alias of scope.aliases) store.removeItem(storageKey(alias));
  } catch {
    // Storage full or unavailable: the draft only lives in memory, as before.
  }
}

export function clearStoredAutomationDraft(scope: AutomationDraftScope | null): void {
  if (!scope) return;
  const store = storage();
  if (!store) return;
  for (const scopeKey of [scope.key, ...scope.aliases]) {
    try {
      store.removeItem(storageKey(scopeKey));
    } catch {
      // Nothing to clear.
    }
  }
}
