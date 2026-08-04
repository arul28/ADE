import type { AgentChatSession } from "../../../../shared/types";

/**
 * The host answers every chat-creating command (`chat.create`, `chat.launch`,
 * `cto.ensureSession`) with an `AgentChatSessionSummary` — `sessionId` and
 * `startedAt`. The renderer consumes an `AgentChatSession` — `id` and
 * `createdAt`. Pass the summary through untranslated and the caller reads
 * `undefined` as its session id, which is how a web draft launch ended up
 * dispatching `chat.send` with no session and getting
 * "chat.send requires sessionId." back from the host.
 *
 * Summary-only fields (title, endedAt, lastOutputPreview…) ride along unread;
 * translating the two identity fields is what callers actually depend on.
 */
export function chatSessionFromRemoteSummary(summary: unknown): AgentChatSession {
  const record = (summary ?? {}) as Record<string, unknown>;
  const { sessionId, startedAt, ...rest } = record;
  return {
    ...rest,
    id: typeof sessionId === "string" ? sessionId : String(rest.id ?? ""),
    createdAt: typeof startedAt === "string" ? startedAt : String(rest.createdAt ?? ""),
  } as unknown as AgentChatSession;
}
