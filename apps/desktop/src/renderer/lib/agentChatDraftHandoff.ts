export type AgentChatDraftHandoffTarget =
  | { sessionId: string }
  | { draftTargetId: string };

type PendingDraftHandoff = {
  text: string;
  queuedAt: number;
  maxAgeMs: number;
};

const pendingByTarget = new Map<string, PendingDraftHandoff>();
const MAX_PENDING_AGE_MS = 30_000;
/**
 * How long a quote waits for its chat. A prompt is handed over by going to the
 * chat, so 30 seconds covers it; quotes are collected first (several items
 * from a pull request) and the reader opens the chat when they are done.
 */
export const QUOTE_HANDOFF_MAX_AGE_MS = 15 * 60_000;

function targetKey(target: AgentChatDraftHandoffTarget): string {
  return "sessionId" in target
    ? `session:${target.sessionId}`
    : `draft:${target.draftTargetId}`;
}

/**
 * Puts `text` in a chat's composer: now when that composer is on screen, else
 * when it next opens. `collect` is for quotes: text already waiting for the
 * same chat is kept and this is added after it, and the wait is longer.
 */
export function queueAgentChatDraftHandoff(
  target: AgentChatDraftHandoffTarget,
  text: string,
  options: { collect?: boolean } = {},
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const key = targetKey(target);
  const now = Date.now();
  const waiting = options.collect ? pendingByTarget.get(key) ?? null : null;
  const kept = waiting && now - waiting.queuedAt <= waiting.maxAgeMs ? `${waiting.text}\n\n` : "";
  pendingByTarget.set(key, {
    text: `${kept}${trimmed}`,
    queuedAt: now,
    maxAgeMs: options.collect ? QUOTE_HANDOFF_MAX_AGE_MS : MAX_PENDING_AGE_MS,
  });
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
  if (Date.now() - pending.queuedAt > pending.maxAgeMs) return null;
  return pending.text;
}
