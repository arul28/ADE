// ---------------------------------------------------------------------------
// Codex `thread/sample` (experimental, Codex 0.164+).
//
// One model answer on a hidden, ephemeral fork of a chat's own thread. The
// fork inherits the thread's model, config and whole history, so the model
// already knows the conversation and ADE does not resend a transcript
// excerpt. The source thread is never changed. Codex's rules
// (app-server/src/thread_sample.rs at rust-v0.164.0):
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
// A sample runs on the chat's own model with its whole context, which costs
// far more than ADE's cheap helper model (measured ~16x on a short chat). So
// every caller asks the helper first and samples only when the helper failed.
// ---------------------------------------------------------------------------

import type { Logger } from "../logging/logger";

/** Codex's own cap on `thread/sample` prompts, in UTF-8 bytes. */
const CODEX_SAMPLE_MAX_PROMPT_BYTES = 4_000;

export type CodexSamplePurpose = "prompt_suggestion" | "session_title" | "session_metadata";

export type CodexSampleOutcome =
  | { kind: "answered"; text: string | null }
  /** A sample cannot run for this chat (older Codex, another provider, a Fast chat). */
  | { kind: "unsupported"; reason: string }
  /** The chat moved on (a new turn, a different latest turn): drop the answer. */
  | { kind: "stale"; reason: string }
  | { kind: "failed"; reason: string };

type CodexSampleRequest = (
  method: string,
  params: unknown,
  options: { timeoutMs: number; onRequestId?: (id: number) => void },
) => Promise<unknown>;

/** What a chat must provide, checked when its sample actually starts (not when it is queued). */
type CodexSampleTarget = {
  threadId: string;
  request: CodexSampleRequest;
  /** The chat model's lowest effort tier, or null to leave the chat's own. */
  effort: string | null;
  /** False once the chat's runtime was replaced: a cancel then goes nowhere. */
  isCurrent: () => boolean;
};

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
function classifyCodexSampleError(error: unknown): Exclude<CodexSampleOutcome, { kind: "answered" }> {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (STALE_SAMPLE_ERROR.test(message)) return { kind: "stale", reason: message };
  if (code === METHOD_NOT_FOUND || UNSUPPORTED_SAMPLE_ERROR.test(message)) {
    return { kind: "unsupported", reason: message };
  }
  return { kind: "failed", reason: message };
}

const RATE_LIMIT_ERROR = /\b429\b|too many requests|rate[_ ]limit|at capacity/i;
const DEFAULT_SAMPLE_COOLDOWN_MS = 60_000;
const MAX_SAMPLE_COOLDOWN_MS = 10 * 60_000;

/**
 * How long to stop sampling after a rate-limited request on the same
 * account, or null when the error was not a rate limit. Samples count toward
 * the same per-turn limit as the chat's real turns (measured: a burst of
 * samples drew a 429 with `Retry-After: 282` that also held the next real
 * turn), so background work backs off rather than spend the user's next turn.
 */
function codexSampleRateLimitCooldownMs(reason: string): number | null {
  if (!RATE_LIMIT_ERROR.test(reason)) return null;
  const retryAfter = /retry-after\W+(\d+)/i.exec(reason)?.[1];
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1_000, MAX_SAMPLE_COOLDOWN_MS)
    : DEFAULT_SAMPLE_COOLDOWN_MS;
}

/** Reads a `thread/sample` response; token counts arrive as JSON numbers. */
function readCodexSampleResponse(response: unknown): {
  text: string | null;
  usage: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null };
} {
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

type CodexThreadSampleRequest = {
  sessionId: string;
  /** The provider account the chat runs as; a rate limit is that account's. */
  accountKey: string;
  turnId: string;
  prompt: string;
  timeoutMs: number;
  purpose: CodexSamplePurpose;
  /** The helper call that failed first, when there was one: a rate limit there skips the sample too. */
  helperError?: string | null;
  /** Gates that need the live chat; a non-target return is the outcome. */
  prepare: () => CodexSampleTarget | Exclude<CodexSampleOutcome, { kind: "answered" }>;
};

/**
 * Runs samples one at a time per chat (a title and a suggestion after the
 * same turn queue rather than race into the per-turn rate limit), and pauses
 * an account's sampling for its Retry-After after any rate limit. Never
 * rejects: every failure comes back as an outcome.
 */
export function createCodexThreadSampler(deps: {
  logger: Logger;
  isTimeoutError: (error: unknown) => boolean;
}) {
  const { logger } = deps;
  const queueBySession = new Map<string, Promise<CodexSampleOutcome>>();
  const cooldownUntilByAccount = new Map<string, number>();

  const noteRateLimit = (accountKey: string, reason: string): boolean => {
    const cooldownMs = codexSampleRateLimitCooldownMs(reason);
    if (cooldownMs == null) return false;
    const until = Date.now() + cooldownMs;
    cooldownUntilByAccount.set(accountKey, Math.max(cooldownUntilByAccount.get(accountKey) ?? 0, until));
    return true;
  };

  const runNow = async (args: CodexThreadSampleRequest): Promise<CodexSampleOutcome> => {
    if (args.helperError && noteRateLimit(args.accountKey, args.helperError)) {
      return { kind: "failed", reason: "the helper was rate-limited on this account" };
    }
    if (Date.now() < (cooldownUntilByAccount.get(args.accountKey) ?? 0)) {
      return { kind: "failed", reason: "Codex rate-limited a recent request on this account" };
    }
    const target = args.prepare();
    if (!("threadId" in target)) return target;
    let requestId: number | null = null;
    const startedAt = Date.now();
    try {
      const response = await target.request("thread/sample", {
        threadId: target.threadId,
        expectedTurnId: args.turnId,
        prompt: args.prompt,
        ...(target.effort ? { effort: target.effort } : {}),
        turnTrigger: `ade_${args.purpose}`,
      }, {
        timeoutMs: args.timeoutMs,
        onRequestId: (id) => { requestId = id; },
      });
      const { text, usage } = readCodexSampleResponse(response);
      logger.info("agent_chat.codex_thread_sample", {
        sessionId: args.sessionId,
        purpose: args.purpose,
        durationMs: Date.now() - startedAt,
        answered: Boolean(text?.trim()),
        effort: target.effort,
        ...usage,
      });
      return { kind: "answered", text };
    } catch (error) {
      const timedOut = deps.isTimeoutError(error);
      // ADE stopped waiting; tell Codex so the hidden fork is reclaimed now
      // rather than at its own 30 s limit.
      if (timedOut && requestId != null && target.isCurrent()) {
        void target.request("thread/sample/cancel", { requestId }, { timeoutMs: 5_000 }).catch((cancelError) => {
          logger.warn("agent_chat.codex_thread_sample_cancel_failed", {
            sessionId: args.sessionId,
            error: cancelError instanceof Error ? cancelError.message : String(cancelError),
          });
        });
      }
      const outcome = timedOut
        ? { kind: "failed" as const, reason: error instanceof Error ? error.message : String(error) }
        : classifyCodexSampleError(error);
      noteRateLimit(args.accountKey, outcome.reason);
      logger.info("agent_chat.codex_thread_sample", {
        sessionId: args.sessionId,
        purpose: args.purpose,
        durationMs: Date.now() - startedAt,
        outcome: outcome.kind,
        reason: outcome.reason,
      });
      return outcome;
    }
  };

  return {
    sample(args: CodexThreadSampleRequest): Promise<CodexSampleOutcome> {
      const prior = queueBySession.get(args.sessionId);
      const run = (prior ?? Promise.resolve<CodexSampleOutcome | undefined>(undefined))
        .then(() => runNow(args))
        .catch((error): CodexSampleOutcome => {
          // `prepare()` runs outside `runNow`'s try: a gate that throws must
          // still leave a line behind rather than a silently missing answer.
          const reason = error instanceof Error ? error.message : String(error);
          logger.warn("agent_chat.codex_thread_sample_failed", { sessionId: args.sessionId, error: reason });
          return { kind: "failed", reason };
        });
      queueBySession.set(args.sessionId, run);
      void run.then(() => {
        if (queueBySession.get(args.sessionId) === run) queueBySession.delete(args.sessionId);
      });
      return run;
    },
  };
}
