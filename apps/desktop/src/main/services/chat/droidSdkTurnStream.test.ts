import { describe, expect, it } from "vitest";
import type { DroidSdkContextStats } from "./droidSdkProtocol";
import { consumeDroidSdkTurnStream } from "./droidSdkTurnStream";

async function* streamOf(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

function stats(used: number): DroidSdkContextStats {
  return { used, remaining: 2_000 - used, limit: 2_000, accuracy: "exact", updatedAt: "2026-09-23T12:00:00.000Z" };
}

/** A context-stats reader whose reads stay pending until the test settles them. */
function pendingReader() {
  const pending: Array<(value: DroidSdkContextStats | null) => void> = [];
  return {
    pending,
    read: () => new Promise<DroidSdkContextStats | null>((resolve) => { pending.push(resolve); }),
  };
}

describe("consumeDroidSdkTurnStream", () => {
  it("returns the run as soon as the stream ends while a context read is still pending", async () => {
    const posted: unknown[] = [];
    const reader = pendingReader();
    const outcome = await consumeDroidSdkTurnStream({
      stream: streamOf([
        { type: "working_state_changed", state: "compacting_conversation" },
        { type: "working_state_changed", state: "idle" },
        { type: "result", success: true, tokenUsage: { inputTokens: 7 } },
      ]),
      postSdkEvent: (event) => posted.push(event),
      readContextStats: reader.read,
      readWorkerTokenUsage: async () => null,
    });

    // The run settled with the compaction-start read still outstanding, so a
    // Stop after the stream ended finds the result already on its way.
    expect(reader.pending).toHaveLength(1);
    expect(outcome).toMatchObject({ resultSuccess: true, firstError: null, tokenUsage: { inputTokens: 7 } });
    expect(posted).toEqual([
      { type: "working_state_changed", state: "compacting_conversation" },
      { type: "working_state_changed", state: "idle" },
      { type: "result", success: true, tokenUsage: { inputTokens: 7 } },
    ]);

    // Samples post afterwards, in the order they were taken.
    reader.pending[0]!(stats(1_800));
    await flushUntil(() => reader.pending.length === 2);
    reader.pending[1]!(stats(700));
    await flushUntil(() => reader.pending.length === 3);
    reader.pending[2]!(stats(750));
    await outcome.contextSamples;
    expect(posted.slice(3)).toEqual([
      { type: "context_stats", contextStats: stats(1_800), phase: "compaction_start" },
      { type: "context_stats", contextStats: stats(700) },
      { type: "context_stats", contextStats: stats(750) },
    ]);
  });

  it("closes a compaction the stream never closed and stamps every context sample with the send's turn id", async () => {
    const posted: unknown[] = [];
    const outcome = await consumeDroidSdkTurnStream({
      stream: streamOf([
        { type: "working_state_changed", state: "compacting_conversation" },
        { type: "result", success: true },
      ]),
      postSdkEvent: (event) => posted.push(event),
      readContextStats: async () => stats(500),
      readWorkerTokenUsage: async () => null,
      turnId: "turn-7",
    });
    expect(outcome.resultSuccess).toBe(true);
    expect(posted.filter((event) => (event as { type?: string }).type === "working_state_changed").at(-1))
      .toEqual({ type: "working_state_changed", state: "idle" });
    await outcome.contextSamples;
    expect(posted.filter((event) => (event as { type?: string }).type === "context_stats")).toEqual([
      { type: "context_stats", contextStats: stats(500), phase: "compaction_start", turnId: "turn-7" },
      { type: "context_stats", contextStats: stats(500), turnId: "turn-7" },
    ]);
  });

  it("does not let a slow mission-worker usage read hold the stream", async () => {
    const posted: unknown[] = [];
    const completed = { type: "mission_worker_completed", workerSessionId: "worker-1", exitCode: 0 };
    const outcome = await consumeDroidSdkTurnStream({
      stream: streamOf([completed, { type: "result", success: true }]),
      postSdkEvent: (event) => posted.push(event),
      readContextStats: async () => null,
      readWorkerTokenUsage: () => new Promise(() => {}),
      workerUsageDeadlineMs: 5,
    });
    expect(outcome.resultSuccess).toBe(true);
    expect(posted[0]).toEqual(completed);

    const withUsage: unknown[] = [];
    await consumeDroidSdkTurnStream({
      stream: streamOf([completed]),
      postSdkEvent: (event) => withUsage.push(event),
      readContextStats: async () => null,
      readWorkerTokenUsage: async () => ({ inputTokens: 4, outputTokens: 2 }),
    });
    expect(withUsage[0]).toEqual({ ...completed, tokenUsage: { inputTokens: 4, outputTokens: 2 } });
  });

  it("keeps a failed result failed and surfaces its cause", async () => {
    const posted: unknown[] = [];
    const cause = { type: "error", message: "model refused" };
    const outcome = await consumeDroidSdkTurnStream({
      stream: streamOf([{ type: "result", success: false, error: cause }]),
      postSdkEvent: (event) => posted.push(event),
      readContextStats: async () => null,
      readWorkerTokenUsage: async () => null,
    });
    expect(outcome).toMatchObject({ resultSuccess: false, firstError: cause });
    expect(posted[0]).toBe(cause);
    await outcome.contextSamples;
  });
});

async function flushUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i += 1) await Promise.resolve();
  expect(check()).toBe(true);
}
