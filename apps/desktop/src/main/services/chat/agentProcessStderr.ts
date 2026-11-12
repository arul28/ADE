/**
 * An agent process's stderr tail, carried on the error a runtime start throws
 * when that process died, so the turn's failure line can show it behind
 * Details. Any runtime that owns a CLI process attaches it at the point it
 * knows the process is gone (Codex's app-server; ACP agents carry theirs as
 * `acpStderrTail`). The tail must already be redacted by its owner.
 */
const STDERR_TAIL_KEY = "agentStderrTail";

type StderrCarryingError = Error & { [STDERR_TAIL_KEY]?: string };

export function attachAgentStderrTail<E extends Error>(error: E, tail: string | null | undefined): E {
  const trimmed = tail?.trim();
  if (trimmed) (error as StderrCarryingError)[STDERR_TAIL_KEY] = trimmed;
  return error;
}

/** The tail {@link attachAgentStderrTail} put on `error`, or "". */
export function readAgentStderrTail(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const tail = (error as StderrCarryingError)[STDERR_TAIL_KEY];
  return typeof tail === "string" ? tail : "";
}
