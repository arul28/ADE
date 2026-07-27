export type AgentChatDraftHandoffTarget =
  | { sessionId: string }
  | { draftTargetId: string };

type PendingDraftHandoff = {
  text: string;
  queuedAt: number;
};

const pendingByTarget = new Map<string, PendingDraftHandoff>();
const MAX_PENDING_AGE_MS = 30_000;

function targetKey(target: AgentChatDraftHandoffTarget): string {
  return "sessionId" in target
    ? `session:${target.sessionId}`
    : `draft:${target.draftTargetId}`;
}

export function queueAgentChatDraftHandoff(
  target: AgentChatDraftHandoffTarget,
  text: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  pendingByTarget.set(targetKey(target), { text: trimmed, queuedAt: Date.now() });
  window.dispatchEvent(new CustomEvent("ade:agent-chat:insert-draft", {
    detail: { ...target, text: trimmed },
  }));
}

export function takeAgentChatDraftHandoff(
  target: AgentChatDraftHandoffTarget,
): string | null {
  const key = targetKey(target);
  const pending = pendingByTarget.get(key) ?? null;
  if (!pending) return null;
  pendingByTarget.delete(key);
  if (Date.now() - pending.queuedAt > MAX_PENDING_AGE_MS) return null;
  return pending.text;
}

export function clearAgentChatDraftHandoffsForTest(): void {
  pendingByTarget.clear();
}
