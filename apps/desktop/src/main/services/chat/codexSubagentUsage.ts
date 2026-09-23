import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type {
  AgentChatEvent,
  AgentChatSubagentTokenUsage,
  AgentChatUsageConfidence,
  CodexTokenUsageBreakdown,
} from "../../../shared/types/chat";
import { positiveCountOrZero, settleWithin } from "../shared/utils";
import { uncachedInputTokens } from "../usage/tokenSplit";

/**
 * Token usage for Codex collab subagents.
 *
 * Live: the app-server publishes `thread/tokenUsage/updated` for every thread,
 * subagent threads included; its `total` is that thread's cumulative usage.
 *
 * After the fact: Codex writes each subagent thread to its own rollout,
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local ts>-<threadId>.jsonl`, with
 * one `token_usage_record` line per model response. Summing those lines gives
 * the same cumulative figure when no live update reached ADE.
 *
 * Codex counts cached input INSIDE `input_tokens` and reasoning INSIDE
 * `output_tokens`. The subagent usage split is the mutually exclusive one the
 * rest of ADE uses: `inputTokens` is the uncached part, `cacheReadTokens` the
 * cached part; `reasoningTokens` stays a subset of `outputTokens`.
 */

export type CodexSubagentUsage = AgentChatSubagentTokenUsage & { totalTokens?: number };

/** A rollout bigger than this is not read on the completion path. */
export const CODEX_ROLLOUT_USAGE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * How long a subagent's result waits for its rollout read. Past this the
 * result goes out without token usage rather than holding the card open.
 */
export const CODEX_ROLLOUT_USAGE_WAIT_MS = 1_500;

export function codexBreakdownToSubagentUsage(
  breakdown: CodexTokenUsageBreakdown | null | undefined,
  usageConfidence?: AgentChatUsageConfidence,
): CodexSubagentUsage | null {
  if (!breakdown) return null;
  const input = breakdown.inputTokens ?? 0;
  const cacheRead = breakdown.cacheReadTokens ?? 0;
  const output = breakdown.outputTokens ?? 0;
  const totalTokens = breakdown.totalTokens ?? input + output;
  if (input + cacheRead + output + totalTokens === 0) return null;
  return {
    inputTokens: uncachedInputTokens(input, cacheRead, undefined),
    outputTokens: output,
    cacheReadTokens: cacheRead,
    ...(breakdown.cacheWriteTokens != null ? { cacheWriteTokens: breakdown.cacheWriteTokens } : {}),
    ...(breakdown.reasoningTokens != null ? { reasoningTokens: breakdown.reasoningTokens } : {}),
    totalTokens,
    ...(usageConfidence && usageConfidence !== "measured" ? { usageConfidence } : {}),
  };
}

/** Creation time of a UUIDv7 thread id (Codex thread ids are v7), or null. */
export function uuidV7TimestampMs(id: string): number | null {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.exec(id.trim());
  if (!match) return null;
  const ms = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

function localDayDir(sessionsDir: string, ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return path.join(sessionsDir, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The rollout for one thread. Codex names the day directory and the file after
 * the thread's local creation time, which a v7 id carries, so only that day and
 * its neighbours (a clock or zone edge) are listed — never the whole history.
 * A non-v7 id has no creation time to go on and is not searched.
 */
export function findCodexThreadRolloutPath(codexHome: string, threadId: string): string | null {
  const createdAt = uuidV7TimestampMs(threadId);
  if (createdAt == null) return null;
  const sessionsDir = path.join(codexHome, "sessions");
  const suffix = `-${threadId.trim().toLowerCase()}.jsonl`;
  for (const ms of [createdAt, createdAt - DAY_MS, createdAt + DAY_MS]) {
    let names: string[];
    try {
      names = fs.readdirSync(localDayDir(sessionsDir, ms));
    } catch {
      continue;
    }
    const match = names.find((name) => name.startsWith("rollout-") && name.toLowerCase().endsWith(suffix));
    if (match) return path.join(localDayDir(sessionsDir, ms), match);
  }
  return null;
}

/**
 * Sums a thread's `token_usage_record` lines. Streams the file line by line and
 * parses only the lines that can be usage records. A record naming another
 * thread (a forked parent's history) is skipped. Null when the file is missing,
 * too large, or holds no usage.
 */
export async function readCodexRolloutTokenUsage(
  filePath: string,
  threadId: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<CodexSubagentUsage | null> {
  const { maxBytes = CODEX_ROLLOUT_USAGE_MAX_BYTES, signal } = options;
  let size: number;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    return null;
  }
  if (size > maxBytes || signal?.aborted) return null;
  const totals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  let records = 0;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  // Closing the interface ends the loop; destroying only the stream would
  // leave `for await` waiting forever.
  const stop = () => {
    lines.close();
    stream.destroy();
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const line of lines) {
      if (signal?.aborted) return null;
      if (!line.includes("\"token_usage_record\"")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      if (record?.type !== "token_usage_record") continue;
      const payload = record.payload && typeof record.payload === "object"
        ? record.payload as Record<string, unknown>
        : null;
      if (!payload) continue;
      const recordThreadId = typeof payload.thread_id === "string" ? payload.thread_id : null;
      if (recordThreadId && recordThreadId !== threadId) continue;
      const usage = payload.usage && typeof payload.usage === "object"
        ? payload.usage as Record<string, unknown>
        : null;
      if (!usage) continue;
      totals.input += positiveCountOrZero(usage.input_tokens);
      totals.cached += positiveCountOrZero(usage.cached_input_tokens);
      totals.cacheWrite += positiveCountOrZero(usage.cache_write_input_tokens);
      totals.output += positiveCountOrZero(usage.output_tokens);
      totals.reasoning += positiveCountOrZero(usage.reasoning_output_tokens);
      totals.total += positiveCountOrZero(usage.total_tokens);
      records += 1;
    }
  } catch {
    return null;
  } finally {
    signal?.removeEventListener("abort", stop);
    lines.close();
    stream.destroy();
  }
  // A read cut short sums only part of the file: no figure beats a low one.
  if (records === 0 || signal?.aborted) return null;
  return codexBreakdownToSubagentUsage({
    inputTokens: totals.input,
    cacheReadTokens: totals.cached,
    cacheWriteTokens: totals.cacheWrite,
    outputTokens: totals.output,
    reasoningTokens: totals.reasoning,
    ...(totals.total > 0 ? { totalTokens: totals.total } : {}),
  }, "derived");
}

const ROLLOUT_READ_TIMED_OUT = Symbol("rollout read timed out");

/**
 * `readCodexRolloutTokenUsage`, but never longer than `waitMs`: on timeout the
 * read is aborted and the answer is null.
 */
export async function readCodexRolloutTokenUsageWithin(
  filePath: string,
  threadId: string,
  waitMs = CODEX_ROLLOUT_USAGE_WAIT_MS,
): Promise<CodexSubagentUsage | null> {
  const controller = new AbortController();
  const usage = await settleWithin(
    readCodexRolloutTokenUsage(filePath, threadId, { signal: controller.signal }),
    waitMs,
    ROLLOUT_READ_TIMED_OUT,
  );
  if (usage !== ROLLOUT_READ_TIMED_OUT) return usage;
  // Stop streaming a file nobody is waiting for.
  controller.abort();
  return null;
}

export type CodexSubagentResultEvent = Extract<AgentChatEvent, { type: "subagent_result" }>;

/** What a subagent result is for: the chat, the thread, and its live usage. */
export type CodexSubagentResultTarget = {
  sessionId: string;
  threadId: string;
  /** The thread's latest live `thread/tokenUsage/updated` totals, when any arrived. */
  liveUsage: CodexTokenUsageBreakdown | null | undefined;
};

/**
 * Emits each Codex subagent's one result event with the thread's token usage:
 * the live totals when any arrived, otherwise the sum read back once from the
 * thread's rollout (`usageConfidence: "derived"`). On the rollout path the
 * result waits for the read, at most `CODEX_ROLLOUT_USAGE_WAIT_MS`, and then
 * goes out without usage. A newer result for the same chat and thread replaces
 * a pending one, and a result whose thread resumed meanwhile (`isResumed`) is
 * stale and is dropped: the card is running again and its next result closes it.
 */
export function createCodexSubagentResultEmitter<Target extends CodexSubagentResultTarget>(deps: {
  emit: (target: Target, event: CodexSubagentResultEvent) => void;
  isResumed: (target: Target) => boolean;
  /** The thread's rollout file, or null when there is none to read. */
  rolloutPathFor: (target: Target) => string | null;
  readRolloutUsage?: (filePath: string, threadId: string) => Promise<CodexSubagentUsage | null>;
}): (target: Target, event: CodexSubagentResultEvent) => void {
  const readRolloutUsage = deps.readRolloutUsage ?? readCodexRolloutTokenUsageWithin;
  /** The rollout read each result is waiting on, by chat and thread. */
  const pending = new Map<string, symbol>();
  return (target, event) => {
    const withUsage = (usage: CodexSubagentUsage | null): CodexSubagentResultEvent =>
      usage ? { ...event, usage: { ...event.usage, ...usage } } : event;
    const key = `${target.sessionId}\u0000${target.threadId}`;
    const liveUsage = codexBreakdownToSubagentUsage(target.liveUsage);
    const rolloutPath = liveUsage ? null : deps.rolloutPathFor(target);
    if (!rolloutPath) {
      pending.delete(key);
      deps.emit(target, withUsage(liveUsage));
      return;
    }
    const token = Symbol(target.threadId);
    pending.set(key, token);
    void readRolloutUsage(rolloutPath, target.threadId).then((usage) => {
      if (pending.get(key) !== token) return;
      pending.delete(key);
      if (deps.isResumed(target)) return;
      deps.emit(target, withUsage(usage));
    });
  };
}
