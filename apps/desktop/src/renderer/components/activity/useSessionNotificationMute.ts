import { useCallback, useEffect, useRef } from "react";

import { useAccountStatus } from "../../lib/account";
import { activityStore, useActivityStore } from "../../state/activityStore";
import { showToast } from "../app/toast/toastStore";

/**
 * One chat's notification mute, which applies on every device: the list lives
 * in the account's Activity preferences, so it needs no route to the machine
 * the chat runs on. Unavailable while signed out or before this window has
 * loaded the preferences, because a toggle drawn from a guess could say
 * "Mute" for a chat that is already muted.
 */
export function useSessionNotificationMute(sessionId: string): {
  available: boolean;
  muted: boolean;
  toggle: () => void;
} {
  const { status } = useAccountStatus();
  const ownerId = status.signedIn ? status.userId?.trim() || null : null;
  const preferences = useActivityStore((state) => state.preferences);
  const ownerRef = useRef(ownerId);
  useEffect(() => {
    ownerRef.current = ownerId;
  }, [ownerId]);
  const muted = Boolean(preferences?.mutedSessionIds?.includes(sessionId));
  const available = Boolean(
    ownerId
    && preferences
    && typeof window !== "undefined"
    && window.ade?.attention?.setSessionMuted,
  );

  const toggle = useCallback(() => {
    const setSessionMuted = window.ade?.attention?.setSessionMuted;
    const current = activityStore.getState().preferences;
    if (!ownerId || !current || !setSessionMuted) return;
    const nextMuted = !current.mutedSessionIds.includes(sessionId);
    const withMute = (list: readonly string[]) => (nextMuted
      ? [...list.filter((id) => id !== sessionId), sessionId]
      : list.filter((id) => id !== sessionId));
    // Optimistic: the menu closes on click, and the next preferences read
    // replaces this with what the account actually holds.
    activityStore.getState().setPreferences({
      ...current,
      mutedSessionIds: withMute(current.mutedSessionIds),
    });
    void setSessionMuted(ownerId, sessionId, nextMuted).catch((error: unknown) => {
      // A different account may be signed in by now; its settings are not
      // this rollback's to touch.
      const latest = activityStore.getState().preferences;
      if (latest && ownerRef.current === ownerId) {
        activityStore.getState().setPreferences({
          ...latest,
          mutedSessionIds: nextMuted
            ? latest.mutedSessionIds.filter((id) => id !== sessionId)
            : [...latest.mutedSessionIds, sessionId],
        });
      }
      showToast({
        tone: "error",
        title: nextMuted ? "Couldn't mute this chat" : "Couldn't unmute this chat",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [ownerId, sessionId]);

  return { available, muted, toggle };
}
