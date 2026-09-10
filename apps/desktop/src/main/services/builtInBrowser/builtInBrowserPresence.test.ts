import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBuiltInBrowserAgentPresenceTracker,
  type BuiltInBrowserAgentPresenceTracker,
} from "./builtInBrowserPresence";

const EXPIRY_MS = 20_000;

describe("builtInBrowserAgentPresence", () => {
  let presence: BuiltInBrowserAgentPresenceTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    presence = createBuiltInBrowserAgentPresenceTracker({ expiryMs: EXPIRY_MS });
  });

  afterEach(() => {
    presence.dispose();
    vi.useRealTimers();
  });

  it("records a chat as present from its first browser command", () => {
    presence.touch({ chatSessionId: "chat-1", laneId: "lane-1", tabId: "tab-1" });
    expect(presence.list()).toMatchObject([
      { chatSessionId: "chat-1", laneId: "lane-1", tabId: "tab-1" },
    ]);
  });

  it("expires the entry when the agent stops using the browser", () => {
    const changes = vi.fn();
    presence.subscribe(changes);
    presence.touch({ chatSessionId: "chat-1" });
    expect(changes).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(EXPIRY_MS - 1);
    expect(presence.list()).toHaveLength(1);

    vi.advanceTimersByTime(2);
    expect(presence.list()).toHaveLength(0);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("keeps a busy agent present without re-announcing it", () => {
    const changes = vi.fn();
    presence.subscribe(changes);
    presence.touch({ chatSessionId: "chat-1", tabId: "tab-1" });
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(EXPIRY_MS / 2);
      presence.touch({ chatSessionId: "chat-1", tabId: "tab-1" });
    }
    expect(presence.list()).toHaveLength(1);
    // One event for "started browsing"; a heartbeat is not news.
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("announces a move to another tab", () => {
    const changes = vi.fn();
    presence.subscribe(changes);
    presence.touch({ chatSessionId: "chat-1", tabId: "tab-1" });
    presence.touch({ chatSessionId: "chat-1", tabId: "tab-2" });
    expect(changes).toHaveBeenCalledTimes(2);
    expect(presence.list()[0]?.tabId).toBe("tab-2");
  });

  it("holds presence through a recording that issues no commands", () => {
    presence.touch({ chatSessionId: "chat-1", tabId: "tab-1" });
    presence.holdForTab("tab-1");

    vi.advanceTimersByTime(EXPIRY_MS * 10);
    expect(presence.list()).toHaveLength(1);

    presence.releaseHoldForTab("tab-1");
    vi.advanceTimersByTime(EXPIRY_MS - 1);
    expect(presence.list()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(presence.list()).toHaveLength(0);
  });

  it("does not resurrect a cleared chat when a hold arrives for its tab", () => {
    presence.touch({ chatSessionId: "chat-1", tabId: "tab-1" });
    presence.clearForTab("tab-1");
    presence.holdForTab("tab-1");
    expect(presence.list()).toHaveLength(0);
  });

  it("clears on tab close, and on the chat ending", () => {
    presence.touch({ chatSessionId: "chat-1", tabId: "tab-1" });
    presence.touch({ chatSessionId: "chat-2", tabId: "tab-2" });

    presence.clearForTab("tab-1");
    expect(presence.list().map((entry) => entry.chatSessionId)).toEqual(["chat-2"]);

    presence.clearForChatSession("chat-2");
    expect(presence.list()).toHaveLength(0);
  });

  it("scopes a read to the asking project, and shares personal-collection agents", () => {
    presence.touch({ chatSessionId: "chat-a", projectRoot: "/tmp/project-a" });
    presence.touch({ chatSessionId: "chat-b", projectRoot: "/tmp/project-b" });
    presence.touch({ chatSessionId: "chat-personal" });

    expect(
      presence.list({ projectRoot: "/tmp/project-a" }).map((entry) => entry.chatSessionId).sort(),
    ).toEqual(["chat-a", "chat-personal"]);
    expect(presence.list()).toHaveLength(3);
  });

  it("orders by most recent activity", () => {
    presence.touch({ chatSessionId: "chat-1" });
    vi.advanceTimersByTime(10);
    presence.touch({ chatSessionId: "chat-2" });
    expect(presence.list().map((entry) => entry.chatSessionId)).toEqual(["chat-2", "chat-1"]);
  });

  it("keeps `since` at the start of the stretch while activity moves", () => {
    presence.touch({ chatSessionId: "chat-1" });
    const since = presence.list()[0]?.since;
    vi.advanceTimersByTime(5_000);
    presence.touch({ chatSessionId: "chat-1" });
    const entry = presence.list()[0];
    expect(entry?.since).toBe(since);
    expect(entry?.lastActivityAt).not.toBe(since);
  });

  it("ignores a listener that throws", () => {
    presence.subscribe(() => {
      throw new Error("listener fault");
    });
    expect(() => presence.touch({ chatSessionId: "chat-1" })).not.toThrow();
    expect(presence.list()).toHaveLength(1);
  });
});
