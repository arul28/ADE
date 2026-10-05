import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatMessageSessionArgs } from "../../../shared/types";
import { createChatWaitRegistry } from "./chatWaitRegistry";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

type Summary = Record<string, unknown> | null | Error;

function harness(initial: Record<string, Summary>) {
  const summaries = new Map<string, Summary>(Object.entries(initial));
  const sent: AgentChatMessageSessionArgs[] = [];
  let store: unknown = null;
  // Each read resolves on the next macrotask, so a check spans real awaits.
  const readSummary = vi.fn(async (sessionId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const value = summaries.get(sessionId) ?? null;
    if (value instanceof Error) throw value;
    return value;
  });
  const registry = createChatWaitRegistry({
    logger,
    db: { getJson: () => store, setJson: (_key, value) => { store = value; } },
    readSummary,
    describeTarget: async (sessionId) => `- ${sessionId}`,
    sessionExists: (sessionId) => summaries.has(sessionId),
    messageSession: async (args) => { sent.push(args); },
    whenReady: async () => {},
  });
  return { registry, summaries, sent, readSummary };
}

describe("chatWaitRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes the caller once even when the target's events overlap a check in flight", async () => {
    const { registry, summaries, sent } = harness({ caller: { status: "active" }, worker: { status: "active" } });
    await registry.arm({ callerSessionId: "caller", targetSessionIds: ["worker"], waitFor: "idle" });
    await vi.advanceTimersByTimeAsync(400);
    expect(sent).toHaveLength(0);

    summaries.set("worker", { status: "idle" });
    registry.signal("worker");
    await vi.advanceTimersByTimeAsync(300); // first check is now mid-read
    registry.signal("worker");
    registry.signal("worker");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent).toHaveLength(1);
    // ADE wrote the wake, so it must not count as the user engaging the chat.
    expect(sent[0]).toMatchObject({ sessionId: "caller", kind: "wake", metadata: { hostContinuation: { reason: "chat_wait" } } });
    expect(await registry.list()).toEqual([]);
  });

  it("does not fire a wait cancelled while its targets were being read", async () => {
    const { registry, summaries, sent } = harness({ caller: { status: "active" }, worker: { status: "active" } });
    const waiter = await registry.arm({ callerSessionId: "caller", targetSessionIds: ["worker"] });
    summaries.set("worker", { status: "idle" });
    registry.signal("worker");
    await vi.advanceTimersByTimeAsync(300); // debounce passed, read in flight
    expect(await registry.cancel({ waiterId: waiter.id })).toEqual({ cancelled: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
  });

  it("treats a failed read as not yet, and sends a queued prompt once the target is really done", async () => {
    const { registry, summaries, sent } = harness({ b: { status: "idle" }, a: new Error("summary read failed") });
    await registry.arm({ targetSessionIds: ["a"], sendToSessionId: "b", text: "start the review" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);

    summaries.set("a", { status: "idle" });
    registry.signal("a");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ sessionId: "b", kind: "wake", text: "start the review" }]);
  });
});
