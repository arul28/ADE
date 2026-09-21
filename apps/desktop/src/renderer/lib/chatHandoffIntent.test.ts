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

  it("keeps the latest intent per session and unsubscribes cleanly", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatHandoff(listener);
    openChatHandoff("chat-3", "remote");
    unsubscribe();

    openChatHandoff("chat-3", "local");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(takeChatHandoff("chat-3")).toBe("local");
  });
});
