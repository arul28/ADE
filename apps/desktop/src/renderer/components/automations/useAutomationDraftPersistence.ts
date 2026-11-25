/**
 * Keeps the stored copy of the builder's draft (`automationDraftStore.ts`) in
 * step with the draft: written shortly after each unsaved change (and at once
 * when the page goes away or the builder unmounts), removed once the draft
 * matches its saved rule (Save, Discard).
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AutomationRuleDraft } from "../../../shared/types";
import {
  clearStoredAutomationDraft,
  storeAutomationDraft,
  type AutomationDraftScope,
  type StoredAutomationDraft,
  type StoredAutomationDraftEntry,
} from "./automationDraftStore";

/** How long typing in the builder waits before the draft is written to local storage. */
const DRAFT_WRITE_DELAY_MS = 300;

type DraftPersistenceArgs = {
  scope: AutomationDraftScope | null;
  /** False until the stored draft was restored or found absent; nothing is written before. */
  restoreDoneRef: MutableRefObject<boolean>;
  draft: AutomationRuleDraft | null;
  isDirty: boolean;
  savedSnapshotRef: MutableRefObject<string | null>;
  /** The rest of the entry, beside the draft and its snapshot. */
  ruleKey: string | null;
  ruleId: string | null;
  ruleMachineId: string | null;
  targetMachineId: string | null;
  machineChosen: boolean;
  cloudChosen: boolean;
  rehomeChosen: boolean;
};

export function useAutomationDraftPersistence({
  scope,
  restoreDoneRef,
  draft,
  isDirty,
  savedSnapshotRef,
  ruleKey,
  ruleId,
  ruleMachineId,
  targetMachineId,
  machineChosen,
  cloudChosen,
  rehomeChosen,
}: DraftPersistenceArgs): {
  /** When the restored draft was last edited; set until it is saved or discarded. */
  restoredDraftAt: string | null;
  /** Call when a stored draft was put back into the builder. */
  noteRestored: (stored: StoredAutomationDraft) => void;
} {
  const [restoredDraftAt, setRestoredDraftAt] = useState<string | null>(null);
  // The persist effect can run in the same commit as the restore, still
  // holding the draft from before it; that one run is skipped instead of
  // clearing the stored copy and the banner.
  const skipStaleRunForRef = useRef<AutomationRuleDraft | null>(null);
  // The stored draft is shared by every window on the repository. A window
  // removes it only when it wrote or restored it, so a clean builder in one
  // window never deletes another window's unsaved draft.
  const ownsStoredRef = useRef(false);
  const noteRestored = useCallback((stored: StoredAutomationDraft) => {
    setRestoredDraftAt(stored.savedAt);
    skipStaleRunForRef.current = stored.draft;
    ownsStoredRef.current = true;
  }, []);

  const pendingRef = useRef<{ scope: AutomationDraftScope; entry: StoredAutomationDraftEntry } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    storeAutomationDraft(pending.scope, pending.entry);
    ownsStoredRef.current = true;
  }, []);

  useEffect(() => {
    if (!restoreDoneRef.current || !scope) return;
    const restored = skipStaleRunForRef.current;
    skipStaleRunForRef.current = null;
    if (restored && draft !== restored) return;
    if (!draft || !isDirty || savedSnapshotRef.current == null) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingRef.current = null;
      if (ownsStoredRef.current) clearStoredAutomationDraft(scope);
      ownsStoredRef.current = false;
      setRestoredDraftAt(null);
      return;
    }
    pendingRef.current = {
      scope,
      entry: {
        draft,
        savedSnapshot: savedSnapshotRef.current,
        ruleKey,
        ruleId,
        ruleMachineId,
        targetMachineId,
        machineChosen,
        cloudChosen,
        rehomeChosen,
      },
    };
    if (!timerRef.current) timerRef.current = setTimeout(flush, DRAFT_WRITE_DELAY_MS);
    // The refs are read at run time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudChosen, draft, flush, isDirty, machineChosen, rehomeChosen, ruleId, ruleKey, ruleMachineId, scope, targetMachineId]);

  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flush]);

  return { restoredDraftAt, noteRestored };
}
