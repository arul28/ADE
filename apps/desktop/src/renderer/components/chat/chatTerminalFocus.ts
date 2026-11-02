/**
 * "Show this chat's terminal": a request the chat's terminal drawer takes
 * whenever it is on screen, whether it was open already or mounts because of
 * the request (the Work tools pane mounts its drawer only while the terminal
 * tool is picked).
 *
 * The request carries the terminal itself, so the drawer can show a terminal
 * that has already ended: the chat's terminal list leaves those out, and a
 * quick command can end before the drawer has listed it at all.
 *
 * One pending terminal per chat; a newer request replaces it.
 */

export type ChatTerminalFocusRequest = {
  terminalId: string;
  ptyId: string;
  label: string;
  /** Its process has exited: the tab shows its output, not a live shell. */
  ended: boolean;
};

const pendingByChat = new Map<string, ChatTerminalFocusRequest>();
const listeners = new Set<(chatSessionId: string) => void>();

export function requestChatTerminalFocus(chatSessionId: string, request: ChatTerminalFocusRequest): void {
  pendingByChat.set(chatSessionId, request);
  for (const listener of listeners) listener(chatSessionId);
}

/** Take the terminal waiting to be shown for this chat, if any. */
export function takeChatTerminalFocus(chatSessionId: string): ChatTerminalFocusRequest | null {
  const request = pendingByChat.get(chatSessionId) ?? null;
  pendingByChat.delete(chatSessionId);
  return request;
}

export function onChatTerminalFocusRequest(listener: (chatSessionId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
