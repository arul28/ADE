import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openChatHandoff,
  resetChatHandoffIntentForTest,
  subscribeChatHandoff,
  takeChatHandoff,
} from "./chatHandoffIntent";

afterEach(() => {
  resetChatHandoffIntentForTest();
  vi.restoreAllMocks();
});

describe("chatHandoffIntent", () => {
  it("delivers an intent to a live listener and leaves a take-once entry", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatHandoff(listener);

    openChatHandoff("chat-1", "local");

    expect(listener).toHaveBeenCalledWith("chat-1", "local");
    // The pane's listener consumes the queue entry; taking is idempotent after.
    expect(takeChatHandoff("chat-1")).toBe("local");
    expect(takeChatHandoff("chat-1")).toBeNull();
    unsubscribe();
  });

  it("queues an intent for a session that is not listening yet", () => {
    const listener = vi.fn();
    subscribeChatHandoff(listener);

    openChatHandoff("chat-2", "remote");

    // The listener heard it but does not own this session; nothing consumed it.
    expect(takeChatHandoff("chat-1")).toBeNull();
    expect(takeChatHandoff("chat-2")).toBe("remote");
    // Take clears, so a second mount cannot replay the same command.
    expect(takeChatHandoff("chat-2")).toBeNull();
  });

  it("last write wins for the single queued slot, and unsubscribes cleanly", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatHandoff(listener);
    openChatHandoff("chat-3", "remote");
    unsubscribe();

    openChatHandoff("chat-3", "local");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(takeChatHandoff("chat-3")).toBe("local");
  });

  it("discards a queued intent older than the staleness bound", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    openChatHandoff("chat-4", "remote");

    // The target pane never mounted; much later the same session is selected.
    now.mockReturnValue(1_000 + 30_001);

    expect(takeChatHandoff("chat-4")).toBeNull();
    // And it is cleared, so it cannot fire on any later take.
    now.mockReturnValue(1_000 + 30_002);
    expect(takeChatHandoff("chat-4")).toBeNull();
  });

  it("delivers a queued intent within the staleness bound", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
    openChatHandoff("chat-5", "local");

    now.mockReturnValue(2_000 + 29_999);

    expect(takeChatHandoff("chat-5")).toBe("local");
  });
});
