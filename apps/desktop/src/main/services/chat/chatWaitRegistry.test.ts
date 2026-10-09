import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatMessageSessionArgs } from "../../../shared/types";
import { createChatWaitRegistry } from "./chatWaitRegistry";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

type Summary = Record<string, unknown> | null | Error;

function harness(initial: Record<string, Summary>, ownedByAnotherBrain: ReadonlySet<string> = new Set()) {
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
    ownedByAnotherBrain: (sessionId) => ownedByAnotherBrain.has(sessionId),
    whenReady: async () => {},
  });
  // `arm` reads each target once (the fake read waits on a timer).
  const arm = async (args: Parameters<typeof registry.arm>[0]) => {
    const armed = registry.arm(args);
    await vi.advanceTimersByTimeAsync(150);
    return armed;
  };
  return { registry, arm, summaries, sent, readSummary };
}

describe("chatWaitRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes the caller once even when the target's events overlap a check in flight", async () => {
    const { registry, arm, summaries, sent } = harness({ caller: { status: "active" }, worker: { status: "active" } });
    await arm({ callerSessionId: "caller", targetSessionIds: ["worker"], waitFor: "idle" });
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
    const { registry, arm, summaries, sent } = harness({ caller: { status: "active" }, worker: { status: "active" } });
    const waiter = await arm({ callerSessionId: "caller", targetSessionIds: ["worker"] });
    summaries.set("worker", { status: "idle" });
    registry.signal("worker");
    // The arm's check fires 250 ms after arming and its read takes 100 ms:
    // cancel lands while that read is in flight.
    await vi.advanceTimersByTimeAsync(230);
    expect(await registry.cancel({ waiterId: waiter.id })).toEqual({ cancelled: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
  });

  it("treats a failed read as not yet, and sends a queued prompt once the target is really done", async () => {
    const { registry, arm, summaries, sent } = harness({ b: { status: "idle" }, a: new Error("summary read failed") });
    await arm({ targetSessionIds: ["a"], sendToSessionId: "b", text: "start the review" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);

    summaries.set("a", { status: "idle" });
    registry.signal("a");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ sessionId: "b", kind: "wake", text: "start the review" }]);
  });

  // Waiters live in the project database every brain on it loads. A brain
  // that does not run a chat saw it "idle" and woke the caller with a false
  // "reached idle" (2026-10-09), starting a second process for the caller.
  it.each([
    ["the target", { caller: { status: "active" }, worker: { status: "idle", runtimeOwnedElsewhere: { pid: 4242 } } }, new Set<string>()],
    ["the chat to wake", { caller: { status: "idle" }, worker: { status: "idle" } }, new Set(["caller"])],
  ])("leaves a wait alone when another brain runs %s", async (_label, summaries, owned) => {
    const { registry, arm, sent } = harness(summaries, owned);
    await arm({ callerSessionId: "caller", targetSessionIds: ["worker"], waitFor: "idle" });
    registry.signal("worker");
    await vi.advanceTimersByTimeAsync(20_000);

    expect(sent).toEqual([]);
    expect(await registry.list()).toHaveLength(1);
  });
});
