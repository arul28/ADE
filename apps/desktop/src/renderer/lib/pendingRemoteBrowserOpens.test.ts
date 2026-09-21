import { beforeEach, describe, expect, it } from "vitest";
import type { BuiltInBrowserRemoteRequest } from "../../shared/types/builtInBrowserRemote";
import {
  consumeMatchingRemoteBrowserOpen,
  holdRemoteBrowserOpen,
  markRemoteBrowserOpenHandled,
  REMOTE_BROWSER_OPEN_HOLD_TTL_MS,
  resetRemoteBrowserOpensForTests,
  setRemoteBrowserOpenClockForTests,
  takeHeldRemoteBrowserOpen,
  wasRemoteBrowserOpenHandled,
} from "./pendingRemoteBrowserOpens";

const STUDIO = { key: "remote:target-studio:project-a" };
const LAPTOP = { key: "remote:target-laptop:project-a" };

function request(
  overrides: Partial<BuiltInBrowserRemoteRequest> = {},
): BuiltInBrowserRemoteRequest {
  return {
    requestId: "bbr-1",
    url: "http://127.0.0.1:3000/",
    laneId: "lane-studio",
    chatSessionId: "chat-studio",
    openPanel: true,
    requestedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("pendingRemoteBrowserOpens", () => {
  beforeEach(() => {
    resetRemoteBrowserOpensForTests();
  });

  it("holds an open for the pane that mounts later", () => {
    holdRemoteBrowserOpen(STUDIO, request());
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" }),
    ).toEqual(request());
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" }),
    ).toBeNull();
  });

  it("keeps pins independent", () => {
    holdRemoteBrowserOpen(STUDIO, request());
    expect(
      takeHeldRemoteBrowserOpen(LAPTOP, { sessionId: "chat-studio", laneId: "lane-studio" }),
    ).toBeNull();
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" })?.requestId,
    ).toBe("bbr-1");
  });

  it("leaves a chat-addressed hold for the panel that is that chat", () => {
    holdRemoteBrowserOpen(STUDIO, request());
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-other", laneId: "lane-studio" }),
    ).toBeNull();
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" })?.requestId,
    ).toBe("bbr-1");
  });

  it("does not give a named open to a pane with no session", () => {
    holdRemoteBrowserOpen(STUDIO, request());
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: null, laneId: "lane-studio" }),
    ).toBeNull();
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" })?.requestId,
    ).toBe("bbr-1");
  });

  it("does not re-hold an id the live listener already handled", () => {
    markRemoteBrowserOpenHandled("bbr-1");
    holdRemoteBrowserOpen(STUDIO, request());
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" }),
    ).toBeNull();
    expect(wasRemoteBrowserOpenHandled("bbr-1")).toBe(true);
  });

  it("drops a matching hold once the live listener acts", () => {
    holdRemoteBrowserOpen(STUDIO, request());
    consumeMatchingRemoteBrowserOpen(STUDIO, "bbr-1");
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" }),
    ).toBeNull();
  });

  it("queues a second open for the same pin instead of dropping the first", () => {
    holdRemoteBrowserOpen(STUDIO, request({ requestId: "bbr-1" }));
    holdRemoteBrowserOpen(STUDIO, request({
      requestId: "bbr-2",
      url: "http://127.0.0.1:5173/",
    }));
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" })?.requestId,
    ).toBe("bbr-1");
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" })?.requestId,
    ).toBe("bbr-2");
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" }),
    ).toBeNull();
  });

  it("drops a hold after the handoff window", () => {
    setRemoteBrowserOpenClockForTests(1_000);
    holdRemoteBrowserOpen(STUDIO, request());
    setRemoteBrowserOpenClockForTests(1_000 + REMOTE_BROWSER_OPEN_HOLD_TTL_MS + 1);
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" }),
    ).toBeNull();
  });

  it("drops the oldest hold on a pin once the queue is full", () => {
    setRemoteBrowserOpenClockForTests(1_000);
    for (let i = 0; i < 9; i += 1) {
      holdRemoteBrowserOpen(STUDIO, request({
        requestId: `bbr-${i}`,
        url: `http://127.0.0.1:${3000 + i}/`,
      }));
    }
    expect(
      takeHeldRemoteBrowserOpen(STUDIO, { sessionId: "chat-studio", laneId: "lane-studio" })?.requestId,
    ).toBe("bbr-1");
  });
});
