import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codexBreakdownToSubagentUsage,
  createCodexSubagentResultEmitter,
  findCodexThreadRolloutPath,
  type CodexSubagentResultEvent,
  type CodexSubagentResultTarget,
  type CodexSubagentUsage,
  readCodexRolloutTokenUsage,
  readCodexRolloutTokenUsageWithin,
  uuidV7TimestampMs,
} from "./codexSubagentUsage";

// A real Codex subagent thread id (UUIDv7): created 2026-09-21T00:39:15.014Z.
const THREAD_ID = "01a0c167-1b46-7d11-8257-d9827213c3db";
const PARENT_ID = "01a0c0d3-8773-79d1-924d-6b1a87d36dc9";

function usageRecord(threadId: string, usage: Record<string, number>): string {
  return JSON.stringify({
    timestamp: "2026-09-21T00:40:00.000Z",
    type: "token_usage_record",
    payload: { thread_id: threadId, turn_id: "t", usage },
  });
}

describe("Codex subagent usage", () => {
  it("splits Codex input into uncached and cached parts", () => {
    expect(codexBreakdownToSubagentUsage({
      inputTokens: 28_004,
      cacheReadTokens: 27_392,
      cacheWriteTokens: 0,
      outputTokens: 508,
      reasoningTokens: 241,
      totalTokens: 28_512,
    })).toEqual({
      inputTokens: 612,
      outputTokens: 508,
      cacheReadTokens: 27_392,
      cacheWriteTokens: 0,
      reasoningTokens: 241,
      totalTokens: 28_512,
    });
    expect(codexBreakdownToSubagentUsage(null)).toBeNull();
    expect(codexBreakdownToSubagentUsage({})).toBeNull();
    expect(codexBreakdownToSubagentUsage({ inputTokens: 10, outputTokens: 2 }, "derived"))
      .toMatchObject({ totalTokens: 12, usageConfidence: "derived" });
    // A cached part larger than the input means the input is already the
    // uncached part (the shared token-split rule), not a zero.
    expect(codexBreakdownToSubagentUsage({ inputTokens: 100, cacheReadTokens: 400, outputTokens: 1 }))
      .toMatchObject({ inputTokens: 100, cacheReadTokens: 400 });
  });

  it("reads the creation time out of a v7 thread id", () => {
    expect(uuidV7TimestampMs(THREAD_ID)).toBe(1_789_951_155_014);
    expect(uuidV7TimestampMs("child-thread-1")).toBeNull();
    // A v4 id carries no timestamp.
    expect(uuidV7TimestampMs("3f1c2a4e-9b8d-4c7e-a1b2-c3d4e5f6a7b8")).toBeNull();
  });

  describe("rollout fallback", () => {
    let codexHome: string;
    beforeEach(() => {
      codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-rollout-"));
    });
    afterEach(() => {
      fs.rmSync(codexHome, { recursive: true, force: true });
    });

    const writeRollout = (lines: string[]): string => {
      const created = new Date(uuidV7TimestampMs(THREAD_ID)!);
      const pad = (value: number) => String(value).padStart(2, "0");
      const dir = path.join(
        codexHome,
        "sessions",
        String(created.getFullYear()),
        pad(created.getMonth() + 1),
        pad(created.getDate()),
      );
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `rollout-2026-09-20T20-39-15-${THREAD_ID}.jsonl`);
      fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
      return filePath;
    };

    it("finds the thread's rollout in its creation-day directory", () => {
      const filePath = writeRollout([]);
      expect(findCodexThreadRolloutPath(codexHome, THREAD_ID)).toBe(filePath);
      expect(findCodexThreadRolloutPath(codexHome, PARENT_ID)).toBeNull();
      expect(findCodexThreadRolloutPath(codexHome, "child-thread-1")).toBeNull();
    });

    it("sums the thread's token_usage_record lines and skips another thread's", async () => {
      const filePath = writeRollout([
        JSON.stringify({ type: "session_meta", payload: { id: THREAD_ID, source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID } } } } }),
        usageRecord(THREAD_ID, { input_tokens: 1_000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 60, total_tokens: 1_100 }),
        JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
        usageRecord(PARENT_ID, { input_tokens: 99_999, cached_input_tokens: 0, output_tokens: 1, total_tokens: 100_000 }),
        "{ torn line",
        usageRecord(THREAD_ID, { input_tokens: 2_000, cached_input_tokens: 1_900, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 2_050 }),
      ]);
      await expect(readCodexRolloutTokenUsage(filePath, THREAD_ID)).resolves.toEqual({
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 2_700,
        cacheWriteTokens: 0,
        reasoningTokens: 70,
        totalTokens: 3_150,
        usageConfidence: "derived",
      });
    });

    it("skips a rollout over the size cap and one with no usage", async () => {
      const filePath = writeRollout([
        usageRecord(THREAD_ID, { input_tokens: 10, output_tokens: 1, total_tokens: 11 }),
      ]);
      await expect(readCodexRolloutTokenUsage(filePath, THREAD_ID, { maxBytes: 8 })).resolves.toBeNull();
      const empty = writeRollout([JSON.stringify({ type: "session_meta", payload: {} })]);
      await expect(readCodexRolloutTokenUsage(empty, THREAD_ID)).resolves.toBeNull();
      await expect(readCodexRolloutTokenUsage(path.join(codexHome, "missing.jsonl"), THREAD_ID)).resolves.toBeNull();
    });

    it("answers null for a cancelled read, never a partial sum", async () => {
      const filePath = writeRollout([
        usageRecord(THREAD_ID, { input_tokens: 10, output_tokens: 1, total_tokens: 11 }),
      ]);
      await expect(readCodexRolloutTokenUsage(filePath, THREAD_ID, { signal: AbortSignal.abort() })).resolves.toBeNull();
    });

    it("stops waiting on a read that outlasts the bound", async () => {
      const filePath = writeRollout([
        usageRecord(THREAD_ID, { input_tokens: 10, output_tokens: 1, total_tokens: 11 }),
      ]);
      await expect(readCodexRolloutTokenUsageWithin(filePath, THREAD_ID)).resolves.toMatchObject({ totalTokens: 11 });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = readCodexRolloutTokenUsageWithin(filePath, THREAD_ID, 1_500);
        // The bound fires before the file is even stat'ed.
        vi.advanceTimersByTime(1_500);
        await expect(pending).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("createCodexSubagentResultEmitter", () => {
  type Target = CodexSubagentResultTarget & { resumed?: boolean; rolloutPath?: string | null };
  const result = (summary: string): CodexSubagentResultEvent => ({
    type: "subagent_result",
    taskId: THREAD_ID,
    status: "completed",
    summary,
  });
  const setup = () => {
    const emitted: Array<{ target: Target; event: CodexSubagentResultEvent }> = [];
    const reads: Array<{ resolve: (usage: CodexSubagentUsage | null) => void; filePath: string }> = [];
    const emit = createCodexSubagentResultEmitter<Target>({
      emit: (target, event) => emitted.push({ target, event }),
      isResumed: (target) => target.resumed === true,
      rolloutPathFor: (target) => target.rolloutPath ?? null,
      readRolloutUsage: (filePath) => new Promise((resolve) => { reads.push({ resolve, filePath }); }),
    });
    return { emitted, reads, emit };
  };
  const derived: CodexSubagentUsage = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, totalTokens: 6, usageConfidence: "derived" };

  it("emits at once with the live usage and never reads the rollout", () => {
    const { emitted, reads, emit } = setup();
    emit({
      sessionId: "s1",
      threadId: THREAD_ID,
      liveUsage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 5, totalTokens: 15 },
      rolloutPath: "/r.jsonl",
    }, result("done"));
    expect(reads).toHaveLength(0);
    expect(emitted.map((entry) => entry.event)).toEqual([{
      ...result("done"),
      usage: { inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, totalTokens: 15 },
    }]);
  });

  it("emits at once without usage when there is no rollout to read", () => {
    const { emitted, reads, emit } = setup();
    emit({ sessionId: "s1", threadId: THREAD_ID, liveUsage: null }, result("done"));
    expect(reads).toHaveLength(0);
    expect(emitted.map((entry) => entry.event)).toEqual([result("done")]);
  });

  it("waits for the rollout read and carries its derived usage, or goes out bare", async () => {
    const { emitted, reads, emit } = setup();
    emit({ sessionId: "s1", threadId: THREAD_ID, liveUsage: null, rolloutPath: "/r.jsonl" }, result("first"));
    expect(emitted).toHaveLength(0);
    expect(reads[0]?.filePath).toBe("/r.jsonl");
    reads[0]!.resolve(derived);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]!.event).toEqual({ ...result("first"), usage: derived });

    emit({ sessionId: "s1", threadId: THREAD_ID, liveUsage: null, rolloutPath: "/r.jsonl" }, result("second"));
    reads[1]!.resolve(null);
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    expect(emitted[1]!.event).toEqual(result("second"));
  });

  it("drops a result whose thread resumed, and one a newer result replaced", async () => {
    const { emitted, reads, emit } = setup();
    const resumed: Target = { sessionId: "s1", threadId: THREAD_ID, liveUsage: null, rolloutPath: "/r.jsonl" };
    emit(resumed, result("stale"));
    resumed.resumed = true;
    reads[0]!.resolve(derived);
    await Promise.resolve();
    await Promise.resolve();
    expect(emitted).toHaveLength(0);

    emit({ sessionId: "s1", threadId: THREAD_ID, liveUsage: null, rolloutPath: "/r.jsonl" }, result("older"));
    // Another chat's same thread id is its own entry.
    emit({ sessionId: "s2", threadId: THREAD_ID, liveUsage: null }, result("other chat"));
    emit({ sessionId: "s1", threadId: THREAD_ID, liveUsage: null }, result("newer"));
    reads[1]!.resolve(derived);
    await Promise.resolve();
    await Promise.resolve();
    expect(emitted.map((entry) => entry.event.summary)).toEqual(["other chat", "newer"]);
  });
});
