// ---------------------------------------------------------------------------
// Codex `thread/sample` (experimental, Codex 0.164+).
//
// One model answer on a hidden, ephemeral fork of a chat's own thread. The
// fork inherits the thread's model, config and whole history, so the model
// already knows the conversation and the request reuses its prompt cache;
// ADE does not resend a transcript excerpt. The source thread is never
// changed. Codex's rules (app-server/src/thread_sample.rs at rust-v0.164.0):
//
// - the source must be an idle, persistent, root thread, and `expectedTurnId`
//   its latest finished turn; a turn that starts while the sample runs makes
//   Codex discard the answer ("sample source changed");
// - the prompt is at most 4,000 bytes, the answer at most 64 KiB, and Codex
//   gives up after 30 s;
// - the answer is text only: a reply that tries a tool call comes back null;
// - `effort` applies only where the model supports cache-preserving effort
//   updates; elsewhere the chat's own effort is used;
// - the fork runs at the chat's own speed (there is no service-tier override).
//
// Callers keep their old helper call as the fallback for chats where a
// sample cannot run at all ("unsupported"), and drop the answer when the chat
// moved on ("stale").
// ---------------------------------------------------------------------------

/** Codex's own cap on `thread/sample` prompts, in UTF-8 bytes. */
export const CODEX_SAMPLE_MAX_PROMPT_BYTES = 4_000;

export type CodexSampleUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

export type CodexSampleOutcome =
  | { kind: "answered"; text: string | null; usage: CodexSampleUsage; durationMs: number }
  /** A sample cannot run for this chat; the caller may use its helper instead. */
  | { kind: "unsupported"; reason: string }
  /** The chat moved on (a new turn, a different latest turn): drop the answer. */
  | { kind: "stale"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * The sample prompt: a line that keeps the fork from treating it as the
 * user's next task, the request, and optional extra context, cut to Codex's
 * byte cap. The context is cut first, at its end; the request is kept whole.
 */
export function buildCodexSamplePrompt(request: string, context?: string | null): string {
  const head = [
    "[ADE background request. This is not a message from the user and not part of the task.",
    "Do not use tools, do not continue the work, and do not mention this request. Answer only what is asked.]",
    "",
    request.trim(),
  ].join("\n");
  const extra = context?.trim() ? `\n\n${context.trim()}` : "";
  return clipUtf8(`${head}${extra}`, CODEX_SAMPLE_MAX_PROMPT_BYTES);
}

function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  // Never end on half of a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

const STALE_SAMPLE_ERROR = /sample source (?:must be idle|changed|turn must be the latest finished turn)/i;
const UNSUPPORTED_SAMPLE_ERROR = /persistent root thread|method not found|unknown variant|thread not (?:found|loaded)|no rollout found/i;

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

/** Sorts a `thread/sample` error into what the caller should do next. */
export function classifyCodexSampleError(error: unknown): Exclude<CodexSampleOutcome, { kind: "answered" }> {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (STALE_SAMPLE_ERROR.test(message)) return { kind: "stale", reason: message };
  if (code === METHOD_NOT_FOUND || UNSUPPORTED_SAMPLE_ERROR.test(message)) {
    return { kind: "unsupported", reason: message };
  }
  return { kind: "failed", reason: message };
}

const RATE_LIMIT_SAMPLE_ERROR = /\b429\b|too many requests|rate[_ ]limit|at capacity/i;
const DEFAULT_SAMPLE_COOLDOWN_MS = 60_000;
const MAX_SAMPLE_COOLDOWN_MS = 10 * 60_000;

/**
 * How long to stop sampling after a rate-limited sample, or null when the
 * error was not a rate limit. Samples count toward the same per-turn limit as
 * the chat's real turns (measured: a burst of samples drew a 429 with
 * `Retry-After: 282` that also held the next real turn), so a background
 * request must back off rather than spend the user's next turn.
 */
export function codexSampleRateLimitCooldownMs(reason: string): number | null {
  if (!RATE_LIMIT_SAMPLE_ERROR.test(reason)) return null;
  const retryAfter = /retry-after\W+(\d+)/i.exec(reason)?.[1];
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1_000, MAX_SAMPLE_COOLDOWN_MS)
    : DEFAULT_SAMPLE_COOLDOWN_MS;
}

/** Reads a `thread/sample` response; token counts arrive as JSON numbers. */
export function readCodexSampleResponse(response: unknown): { text: string | null; usage: CodexSampleUsage } {
  const record = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    text: typeof record.text === "string" ? record.text : null,
    usage: {
      inputTokens: count(record.inputTokens),
      cachedInputTokens: count(record.cachedInputTokens),
      outputTokens: count(record.outputTokens),
    },
  };
}
