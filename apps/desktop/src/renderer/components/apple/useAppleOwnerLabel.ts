import { useEffect, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";

/**
 * Who owns this device, in words a person recognises.
 *
 * The watch ribbon said `owned by 3f9a2b71` — the first eight characters of a
 * chat session id, which names nothing. The phone already shows the chat's
 * TITLE, because the host resolves it into `apple.status`'s
 * `owner.chatTitle` before the wire (`appleRemoteCommands.ts`). The desktop
 * reads the same chat from the same place, so there is no reason for the two
 * surfaces to disagree about what a chat is called.
 *
 * Falls back to the id slice: a chat whose summary cannot be read is still
 * better identified by eight characters than by "another chat".
 */
export function useAppleOwnerLabel(
  chatSessionId: string | null,
  runtimePin: OpenProjectBinding | null,
): string {
  const fallback = chatSessionId?.slice(0, 8) ?? "another chat";
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!chatSessionId) {
      setTitle(null);
      return undefined;
    }
    let cancelled = false;
    void window.ade?.agentChat
      ?.getSummary({ sessionId: chatSessionId }, runtimePin)
      .then((summary) => {
        if (cancelled) return;
        const next = summary?.title?.trim();
        setTitle(next ? next : null);
      })
      .catch(() => {
        if (!cancelled) setTitle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [chatSessionId, runtimePin]);

  return title ?? fallback;
}
