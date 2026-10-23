import { useEffect } from "react";

import type { AttentionDesktopAlert } from "../../../shared/types";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";

/**
 * A message an agent sent the user (`ade notify` from a chat), shown as a toast
 * in the window the user is looking at. Main sends it only to the focused
 * window and only when no system notification went out, so it shows once.
 */
export function useAgentMessageToasts(): void {
  useEffect(() => {
    const api = window.ade?.attention;
    if (!api?.onAlert) return;
    return api.onAlert((alert: AttentionDesktopAlert) => {
      if (alert.kind !== "message") return;
      showToast({
        // One toast per message; a repeat of the same alert replaces it.
        id: `agent-message:${alert.itemId}`,
        tone: "info",
        title: alert.title,
        ...(alert.body ? { message: alert.body } : {}),
        durationMs: READABLE_TOAST_DURATION_MS,
        actions: [{
          label: "Open chat",
          onClick: () => {
            void api.openAlert?.(alert);
          },
        }],
      });
    });
  }, []);
}
