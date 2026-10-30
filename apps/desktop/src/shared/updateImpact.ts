import type { RuntimeUpdateImpact, UpdateChatContinueHold, UpdateImpact, UpdateInterruptedChat } from "./types";

/** The answer for a machine that could not say what it is running. */
export const UNKNOWN_UPDATE_IMPACT: UpdateImpact = Object.freeze({
  checked: false,
  chats: Object.freeze([]) as unknown as UpdateImpact["chats"],
  cliSessions: 0,
  terminals: 0,
});

function parseChat(raw: unknown): UpdateInterruptedChat | null {
  if (!raw || typeof raw !== "object") return null;
  const chat = raw as Record<string, unknown>;
  if (typeof chat.sessionId !== "string" || !chat.sessionId) return null;
  return {
    sessionId: chat.sessionId,
    title: typeof chat.title === "string" && chat.title.trim() ? chat.title : "Untitled chat",
    projectName: typeof chat.projectName === "string" ? chat.projectName : "",
    projectRoot: typeof chat.projectRoot === "string" ? chat.projectRoot : null,
    ...(chat.resumable === false ? { resumable: false } : {}),
    ...(chat.continueHold === null || (typeof chat.continueHold === "string" && CONTINUE_HOLDS.has(chat.continueHold))
      ? { continueHold: chat.continueHold as UpdateChatContinueHold | null }
      : {}),
  };
}

const CONTINUE_HOLDS: ReadonlySet<string> = new Set(["disabled", "stale", "awaiting_user", "capped", "settled"]);

/**
 * A brain's `runtime.updateImpact` reply, or null when it is not one. The
 * reply crosses a process and often a machine and version boundary, so nothing
 * about its shape is assumed, and each chat keeps only the fields ADE reads.
 */
export function parseRuntimeUpdateImpact(raw: unknown): RuntimeUpdateImpact | null {
  if (!raw || typeof raw !== "object") return null;
  const reply = raw as Partial<Record<keyof RuntimeUpdateImpact, unknown>>;
  if (!Array.isArray(reply.chats)) return null;
  return {
    chats: reply.chats.flatMap((chat) => parseChat(chat) ?? []),
    cliSessions: Number(reply.cliSessions) || 0,
    terminals: Number(reply.terminals) || 0,
    ...(typeof reply.continueAfterRestart === "boolean" ? { continueAfterRestart: reply.continueAfterRestart } : {}),
  };
}
