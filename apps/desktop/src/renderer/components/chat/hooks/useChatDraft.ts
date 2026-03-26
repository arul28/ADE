import { useCallback, useEffect, useRef, useState } from "react";
import { loadDraft, saveDraft, removeDraft } from "./useChatDraftStore";

/**
 * Manages a persisted draft for a chat session.
 * Debounces writes to localStorage to avoid thrashing.
 */
export function useChatDraft(args: {
  sessionId: string | null;
  laneId: string | null;
  modelId?: string;
}) {
  const { sessionId, laneId, modelId } = args;
  // Draft key: use sessionId if we have an active session, otherwise "draft:<laneId>"
  const draftKey = sessionId ?? (laneId ? `draft:${laneId}` : "");

  const [draft, setDraftState] = useState("");
  const saveTimerRef = useRef<number | null>(null);
  const prevKeyRef = useRef(draftKey);

  // Load draft when key changes
  useEffect(() => {
    if (prevKeyRef.current !== draftKey) {
      // Save the old draft before switching
      // (the debounce timer might not have fired yet)
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // Load new draft
      const entry = loadDraft(draftKey);
      setDraftState(entry?.text ?? "");
      prevKeyRef.current = draftKey;
    }
  }, [draftKey]);

  const setDraft = useCallback(
    (text: string) => {
      setDraftState(text);
      // Debounced save
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveDraft(draftKey, text, modelId);
        saveTimerRef.current = null;
      }, 300);
    },
    [draftKey, modelId],
  );

  const clearDraft = useCallback(() => {
    setDraftState("");
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    removeDraft(draftKey);
  }, [draftKey]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  return { draft, setDraft, clearDraft };
}
