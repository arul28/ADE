import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WORK_TOOL_SHOW_REQUEST_EVENT, type WorkToolShowRequest } from "../../../../desktop/src/shared/types/workToolShow";
import { createWorkToolShowRequests } from "./workToolShowRequests";

function setup(overrides: Partial<Parameters<typeof createWorkToolShowRequests>[0]> = {}) {
  const emitted: WorkToolShowRequest[] = [];
  const service = createWorkToolShowRequests({
    emitEvent: (payload) => {
      expect(payload.type).toBe(WORK_TOOL_SHOW_REQUEST_EVENT);
      emitted.push(payload.event as WorkToolShowRequest);
    },
    ackTimeoutMs: 1_000,
    heldGraceMs: 200,
    ...overrides,
  });
  return { service, emitted };
}

describe("workToolShowRequests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the request and answers shown when a desktop takes it", async () => {
    const { service, emitted } = setup();
    const pending = service.show({ surface: "apple", chatSessionId: "chat-1", laneId: "lane-1" });
    expect(emitted).toEqual([
      expect.objectContaining({ surface: "apple", chatSessionId: "chat-1", laneId: "lane-1", auto: false }),
    ]);
    expect(service.acknowledgeShow({ requestId: emitted[0]!.requestId, status: "shown", desktopLabel: "Studio" }))
      .toEqual({ ok: true });
    await expect(pending).resolves.toMatchObject({
      status: "shown",
      surface: "apple",
      chatSessionId: "chat-1",
      desktopLabel: "Studio",
      message: "Showing the Apple device in the tools pane on Studio.",
    });
  });

  it("answers no_desktop when nobody takes it, never shown", async () => {
    const { service } = setup();
    const pending = service.show({ surface: "proof", chatSessionId: "chat-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.status).toBe("no_desktop");
    expect(result.message).toMatch(/No desktop window is open for this chat/);
  });

  it("waits a moment after a held answer for a window that has the chat in front", async () => {
    const { service, emitted } = setup();
    const heldOnly = service.show({ surface: "browser", chatSessionId: "chat-1" });
    service.acknowledgeShow({ requestId: emitted[0]!.requestId, status: "held", desktopLabel: "MacBook" });
    await vi.advanceTimersByTimeAsync(200);
    await expect(heldOnly).resolves.toMatchObject({ status: "held", desktopLabel: "MacBook" });

    const thenShown = service.show({ surface: "browser", chatSessionId: "chat-1" });
    const requestId = emitted[1]!.requestId;
    service.acknowledgeShow({ requestId, status: "held", desktopLabel: "MacBook" });
    service.acknowledgeShow({ requestId, status: "shown", desktopLabel: "Studio" });
    await expect(thenShown).resolves.toMatchObject({ status: "shown", desktopLabel: "Studio" });
    // A late answer to a settled request changes nothing.
    expect(service.acknowledgeShow({ requestId, status: "shown" })).toEqual({ ok: false });
  });

  it("says the surface was opened when the desktop acted but could not confirm it is on screen", async () => {
    const { service, emitted } = setup();
    const pending = service.show({ surface: "apple", chatSessionId: "chat-1" });
    service.acknowledgeShow({ requestId: emitted[0]!.requestId, status: "held", desktopLabel: "MacBook", opened: true });
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result.status).toBe("held");
    expect(result.message).toBe(
      "Opened the Apple device in the tools pane on MacBook, but the window is not in front, so the user may not see it yet.",
    );
  });

  it("a later held answer that opened the tool keeps `opened`", async () => {
    const { service, emitted } = setup();
    const pending = service.show({ surface: "apple", chatSessionId: "chat-1" });
    const requestId = emitted[0]!.requestId;
    service.acknowledgeShow({ requestId, status: "held", desktopLabel: "Studio" });
    service.acknowledgeShow({ requestId, status: "held", desktopLabel: "MacBook", opened: true });
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({
      status: "held",
      desktopLabel: "MacBook",
      message: expect.stringMatching(/^Opened the Apple device/),
    });
  });

  it("refuses an unknown surface and a request with no chat", async () => {
    const { service, emitted } = setup();
    await expect(service.show({ surface: "terminal", chatSessionId: "chat-1" })).rejects.toThrow(/needs a surface/);
    await expect(service.show({ surface: "apple" })).rejects.toThrow(/needs the chat/);
    expect(emitted).toEqual([]);
  });

  it("offers the floating device on agent activity once per chat per window", () => {
    let now = 10_000;
    const { service, emitted } = setup({ activityThrottleMs: 5_000, now: () => now });
    expect(service.noteAgentAppleActivity({ chatSessionId: "chat-1", laneId: "lane-1" })).toBe(true);
    expect(service.noteAgentAppleActivity({ chatSessionId: "chat-1", laneId: "lane-1" })).toBe(false);
    expect(service.noteAgentAppleActivity({ chatSessionId: "chat-2", laneId: "lane-2" })).toBe(true);
    now += 5_000;
    expect(service.noteAgentAppleActivity({ chatSessionId: "chat-1", laneId: "lane-1" })).toBe(true);
    expect(service.noteAgentAppleActivity({ chatSessionId: null, laneId: "lane-1" })).toBe(false);
    expect(emitted.map((request) => [request.surface, request.chatSessionId, request.auto])).toEqual([
      ["floating-apple", "chat-1", true],
      ["floating-apple", "chat-2", true],
      ["floating-apple", "chat-1", true],
    ]);
  });

  it("offers the floating Mac Desktop on agent activity, throttled apart from the Apple device", () => {
    let now = 10_000;
    const { service, emitted } = setup({ activityThrottleMs: 5_000, now: () => now });
    expect(service.noteAgentMacDesktopActivity({ chatSessionId: "chat-1", laneId: "lane-1" })).toBe(true);
    expect(service.noteAgentMacDesktopActivity({ chatSessionId: "chat-1", laneId: "lane-1" })).toBe(false);
    // The same chat driving its Apple device is a different offer.
    expect(service.noteAgentAppleActivity({ chatSessionId: "chat-1", laneId: "lane-1" })).toBe(true);
    now += 5_000;
    expect(service.noteAgentMacDesktopActivity({ chatSessionId: "chat-1", laneId: "lane-1" })).toBe(true);
    expect(emitted.map((request) => [request.surface, request.chatSessionId, request.laneId, request.auto])).toEqual([
      ["floating-mac-desktop", "chat-1", "lane-1", true],
      ["floating-apple", "chat-1", "lane-1", true],
      ["floating-mac-desktop", "chat-1", "lane-1", true],
    ]);
  });

  it("shows the Mac Desktop surfaces like any other", async () => {
    const { service, emitted } = setup();
    const pending = service.show({ surface: "floating-mac-desktop", chatSessionId: "chat-1", laneId: "lane-1" });
    service.acknowledgeShow({ requestId: emitted[0]!.requestId, status: "shown" });
    await expect(pending).resolves.toMatchObject({
      status: "shown",
      surface: "floating-mac-desktop",
      message: "Showing the floating Mac Desktop.",
    });
  });

  it("settles pending shows as no_desktop on dispose", async () => {
    const { service } = setup();
    const pending = service.show({ surface: "apple", chatSessionId: "chat-1" });
    service.dispose();
    await expect(pending).resolves.toMatchObject({ status: "no_desktop" });
  });
});
