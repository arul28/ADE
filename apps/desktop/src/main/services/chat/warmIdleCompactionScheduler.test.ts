import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWarmIdleCompactionScheduler } from "./warmIdleCompactionScheduler";

type Chat = { id: string; idle: boolean; fireAt: number | null };

const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const MINUTE = 60_000;

function setup() {
  const compact = vi.fn(async (_chat: Chat) => undefined);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const scheduler = createWarmIdleCompactionScheduler<Chat>({
    sessionIdOf: (chat) => chat.id,
    // The chat's current answer, read again when the timer fires.
    compactAt: async (chat) => chat.fireAt,
    isIdle: (chat) => chat.idle,
    compact,
    logger,
  });
  return { scheduler, compact, logger };
}

describe("warmIdleCompactionScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("compacts an idle chat when its moment comes, and not before", async () => {
    const { scheduler, compact } = setup();
    const chat: Chat = { id: "c1", idle: true, fireAt: NOW + 54 * MINUTE };
    await scheduler.schedule(chat);

    await vi.advanceTimersByTimeAsync(53 * MINUTE);
    expect(compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(chat);
  });

  it.each([
    ["a turn started (the timer was cleared)", (chat: Chat, scheduler: ReturnType<typeof setup>["scheduler"]) => scheduler.clear(chat.id)],
    ["the chat is busy when the timer fires", (chat: Chat) => { chat.idle = false; }],
    ["the chat's state moved on (a new reading names another moment)", (chat: Chat) => { chat.fireAt = NOW + 120 * MINUTE; }],
    ["the chat no longer qualifies", (chat: Chat) => { chat.fireAt = null; }],
  ])("does not compact when %s", async (_name, change) => {
    const { scheduler, compact } = setup();
    const chat: Chat = { id: "c1", idle: true, fireAt: NOW + 54 * MINUTE };
    await scheduler.schedule(chat);
    change(chat, scheduler);
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(compact).not.toHaveBeenCalled();
  });

  it("skips a timer that fires more than a minute late, as after a machine slept", async () => {
    const { scheduler, compact } = setup();
    const chat: Chat = { id: "c1", idle: true, fireAt: NOW + 54 * MINUTE };
    await scheduler.schedule(chat);
    // The clock jumps past the moment before the timer gets to run.
    vi.setSystemTime(NOW + 56 * MINUTE);
    await vi.advanceTimersByTimeAsync(54 * MINUTE);
    expect(compact).not.toHaveBeenCalled();
  });

  it("lets a turn cancel the compaction after two schedules overlapped", async () => {
    // The older schedule's history read lands last. Kept, it would replace the
    // newer timer in the books, so the turn's clear would miss the timer that
    // is really pending and the chat would compact in the middle of the turn.
    const compact = vi.fn(async (_chat: Chat) => undefined);
    let releaseOlder: (value: number) => void = () => {};
    const olderReading = new Promise<number>((resolve) => { releaseOlder = resolve; });
    let reads = 0;
    const scheduler = createWarmIdleCompactionScheduler<Chat>({
      sessionIdOf: (chat) => chat.id,
      compactAt: async () => (reads++ === 0 ? olderReading : NOW + 60 * MINUTE),
      isIdle: () => true,
      compact,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const chat: Chat = { id: "c1", idle: true, fireAt: null };
    const older = scheduler.schedule(chat);
    await scheduler.schedule(chat);
    releaseOlder(NOW + 10 * MINUTE);
    await older;

    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    scheduler.clear(chat.id);
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    expect(compact).not.toHaveBeenCalled();
  });

  it("logs a compaction that fails instead of throwing, and stops everything on dispose", async () => {
    const { scheduler, compact, logger } = setup();
    compact.mockRejectedValueOnce(new Error("runtime gone"));
    await scheduler.schedule({ id: "c1", idle: true, fireAt: NOW + MINUTE });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(logger.warn).toHaveBeenCalledWith("agent_chat.warm_idle_compaction_failed", expect.objectContaining({ sessionId: "c1" }));

    await scheduler.schedule({ id: "c2", idle: true, fireAt: NOW + 5 * MINUTE });
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});
