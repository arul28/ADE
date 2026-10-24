/**
 * "Open this chat with its actions pane showing."
 *
 * A Work row's subagent mark opens the parent chat on its actions pane, where
 * the chat's subagents are listed. The chat may not be on screen yet (the same
 * press selects it), so the request is held per chat and taken by the pane that
 * renders that chat — on mount, or at once when it is already on screen via the
 * pane's `ade:chat:open-info` entry point.
 */
const pendingRequestedAtMs = new Map<string, number>();

/**
 * How long a press waits for its chat to come on screen. A press whose chat
 * never opens (the select failed, the user went elsewhere) must not pop the
 * pane open the next time that chat is opened some other way.
 */
const REQUEST_TTL_MS = 10_000;

function dropExpired(nowMs: number): void {
  for (const [id, requestedAtMs] of pendingRequestedAtMs) {
    if (nowMs - requestedAtMs > REQUEST_TTL_MS) pendingRequestedAtMs.delete(id);
  }
}

export function requestChatActionsPane(sessionId: string | null | undefined): void {
  const id = sessionId?.trim();
  if (!id) return;
  const nowMs = Date.now();
  dropExpired(nowMs);
  pendingRequestedAtMs.set(id, nowMs);
  try {
    window.dispatchEvent(new CustomEvent("ade:chat:open-info", { detail: { sessionId: id } }));
  } catch {
    /* no-op */
  }
}

/** Take the held request for this chat. True once per request, within its TTL. */
export function takeChatActionsPaneRequest(sessionId: string | null | undefined): boolean {
  const id = sessionId?.trim();
  if (!id) return false;
  dropExpired(Date.now());
  return pendingRequestedAtMs.delete(id);
}
