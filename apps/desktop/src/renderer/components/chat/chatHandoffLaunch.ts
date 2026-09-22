/**
 * A right-click on any session card asks the open chat pane to show a handoff
 * modal. The menu and the pane do not share state, and the pane for that chat
 * may not be mounted yet, so the request waits until the matching session is
 * the one on screen.
 */
export type ChatHandoffLaunch = {
  sessionId: string;
  kind: "local" | "remote";
};

type ChatHandoffListener = (launch: ChatHandoffLaunch) => boolean;

const listeners = new Set<ChatHandoffListener>();
let pending: ChatHandoffLaunch | null = null;

export function requestChatHandoff(launch: ChatHandoffLaunch): void {
  pending = launch;
  for (const listener of listeners) {
    if (listener(launch)) {
      pending = null;
      return;
    }
  }
}

export function subscribeChatHandoff(listener: ChatHandoffListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function takePendingChatHandoff(sessionId: string | null): ChatHandoffLaunch | null {
  if (!sessionId || pending?.sessionId !== sessionId) return null;
  const launch = pending;
  pending = null;
  return launch;
}
