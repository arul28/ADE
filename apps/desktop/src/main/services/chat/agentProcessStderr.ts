import { presentChatFailure } from "../../../shared/chatErrorPresentation";

/**
 * An agent process's stderr tail, carried on the error a runtime start throws
 * when that process died, so the turn's failure line can show it behind
 * Details. Any runtime that owns a CLI process attaches it at the point it
 * knows the process is gone (Codex's app-server, an ACP agent's handshake).
 * The tail must already be redacted by its owner.
 */
const STDERR_TAIL_KEY = "agentStderrTail";

type StderrCarryingError = { [STDERR_TAIL_KEY]?: string };

/** Puts `tail` on `error` (any object; anything else is returned as is). */
export function attachAgentStderrTail<E>(error: E, tail: string | null | undefined): E {
  const trimmed = tail?.trim();
  if (trimmed && error && typeof error === "object") (error as StderrCarryingError)[STDERR_TAIL_KEY] = trimmed;
  return error;
}

/** The tail {@link attachAgentStderrTail} put on `error`, or "". */
export function readAgentStderrTail(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const tail = (error as StderrCarryingError)[STDERR_TAIL_KEY];
  return typeof tail === "string" ? tail : "";
}

/**
 * A failure line's fields when the process left a stderr tail: the card leads
 * with the tail's own line, and Details keep the exit line above the tail.
 * Empty when there is no tail.
 */
export function processStderrErrorFields(providerLabel: string, message: string, stderrTail: string | null | undefined) {
  const tail = stderrTail?.trim();
  if (!tail) return {};
  const card = presentChatFailure({ kind: "unknown", message, provider: providerLabel, stderrTail: tail });
  const technicalDetail = [message, card.technicalDetail]
    .filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index)
    .join("\n\n");
  return {
    detail: technicalDetail,
    errorInfo: { category: "unknown" as const, provider: providerLabel, presentation: { ...card, technicalDetail } },
  };
}
