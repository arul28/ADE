/**
 * The one unsaved automation draft per project, kept in this window's local
 * storage so it survives leaving the Automations tab, a project switch, and an
 * app or brain restart. Save and Discard clear it.
 *
 * It is per project and per Mac: a draft is a person's unfinished edit, not
 * project data, so it never syncs. The target machine is stored by id and
 * matched again on restore; a machine that has gone keeps the draft but asks
 * for a machine again.
 */

import type { AutomationRuleDraft } from "../../../shared/types";

const STORAGE_KEY_PREFIX = "ade.automations.draft.v1";

export type StoredAutomationDraft = {
  version: 1;
  draft: AutomationRuleDraft;
  /** The snapshot the draft is compared with: the saved rule, or the blank or template start. */
  savedSnapshot: string;
  /** The rule key being edited, or null for a new automation. */
  ruleKey: string | null;
  /** The machine the draft targets; null means the tab's own machine. */
  targetMachineId: string | null;
  machineChosen: boolean;
  savedAt: string;
};

function storageKey(projectRoot: string): string {
  return `${STORAGE_KEY_PREFIX}::${projectRoot}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadStoredAutomationDraft(projectRoot: string | null): StoredAutomationDraft | null {
  if (!projectRoot) return null;
  try {
    const raw = storage()?.getItem(storageKey(projectRoot));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAutomationDraft>;
    const draft = parsed?.draft as Partial<AutomationRuleDraft> | undefined;
    if (
      parsed?.version !== 1
      || !draft || typeof draft !== "object" || !Array.isArray(draft.triggers)
      || typeof parsed.savedSnapshot !== "string"
    ) {
      // A record this window cannot use would fail again on every restore.
      clearStoredAutomationDraft(projectRoot);
      return null;
    }
    return {
      version: 1,
      draft: draft as AutomationRuleDraft,
      savedSnapshot: parsed.savedSnapshot,
      ruleKey: typeof parsed.ruleKey === "string" && parsed.ruleKey ? parsed.ruleKey : null,
      targetMachineId: typeof parsed.targetMachineId === "string" && parsed.targetMachineId ? parsed.targetMachineId : null,
      machineChosen: parsed.machineChosen !== false,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function storeAutomationDraft(projectRoot: string | null, entry: Omit<StoredAutomationDraft, "version" | "savedAt">): void {
  if (!projectRoot) return;
  try {
    storage()?.setItem(storageKey(projectRoot), JSON.stringify({ ...entry, version: 1, savedAt: new Date().toISOString() }));
  } catch {
    // Storage full or unavailable: the draft only lives in memory, as before.
  }
}

export function clearStoredAutomationDraft(projectRoot: string | null): void {
  if (!projectRoot) return;
  try {
    storage()?.removeItem(storageKey(projectRoot));
  } catch {
    // Nothing to clear.
  }
}
