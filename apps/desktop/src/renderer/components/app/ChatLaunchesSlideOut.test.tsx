/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLaunchSnapshot, ChatLaunchStage, OpenProjectBinding } from "../../../shared/types";
import {
  applyChatLaunchSnapshot,
  buildOptimisticChatLaunchSnapshot,
  getChatLaunchOriginClientId,
  resetChatLaunchStoreForTests,
} from "../../state/chatLaunchStore";
import {
  CHAT_LAUNCH_SLIDE_OUT_AUTO_DISMISS_MS,
  ChatLaunchesSlideOut,
  currentSlideOutLaunchesForTests,
  slideOutHeadline,
} from "./ChatLaunchesSlideOut";

const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));

const BINDING: OpenProjectBinding = { kind: "local", key: "local:/p", rootPath: "/p", displayName: "p" };

function stage(id: ChatLaunchStage["id"], status: ChatLaunchStage["status"]): ChatLaunchStage {
  return { id, status, startedAt: null, endedAt: null, percent: null, detail: null, error: null };
}

function launch(
  launchId: string,
  kind: ChatLaunchSnapshot["kind"],
  mode: ChatLaunchSnapshot["mode"],
  overrides: Partial<ChatLaunchSnapshot> = {},
): ChatLaunchSnapshot {
  return {
    ...buildOptimisticChatLaunchSnapshot({
      launch: {
        kind,
        mode,
        launchId,
        laneId: `lane-${launchId}`,
        laneName: `Lane ${launchId}`,
        prompt: `Prompt ${launchId}`,
        originClientId: getChatLaunchOriginClientId(),
      },
      includeFetch: true,
    }),
    sequence: 1,
    ...overrides,
  };
}

beforeEach(() => {
  (window as unknown as { ade: unknown }).ade = { chatLaunch: {} };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetChatLaunchStoreForTests();
  navigateMock.mockReset();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ChatLaunchesSlideOut", () => {
  it("shows background chats and CLI launches of this window, never a foreground chat", () => {
    applyChatLaunchSnapshot(BINDING, launch("fg-chat", "chat", "foreground"));
    applyChatLaunchSnapshot(BINDING, launch("bg-chat", "chat", "background"));
    applyChatLaunchSnapshot(BINDING, launch("fg-cli", "cli", "foreground"));
    applyChatLaunchSnapshot(BINDING, launch("bg-cli", "cli", "background"));
    applyChatLaunchSnapshot(BINDING, launch("elsewhere", "chat", "background", { originClientId: "phone" }));
    applyChatLaunchSnapshot(BINDING, launch("gone", "cli", "background", { phase: "cancelled" }));

    expect(currentSlideOutLaunchesForTests().map((entry) => entry.launchId).sort()).toEqual(["bg-chat", "bg-cli", "fg-cli"]);
    render(<ChatLaunchesSlideOut />);
    expect(screen.getAllByTestId("chat-launch-row")).toHaveLength(3);
    expect(screen.getByTestId("chat-launches-headline").textContent).toBe("Setting up 3 lanes…");
  });

  it("renders nothing when there is nothing of ours to show", () => {
    applyChatLaunchSnapshot(BINDING, launch("fg-chat", "chat", "foreground"));
    const { container } = render(<ChatLaunchesSlideOut />);
    expect(container.firstChild).toBeNull();
  });

  it("leaves on its own once everything it shows has started", () => {
    vi.useFakeTimers();
    applyChatLaunchSnapshot(BINDING, launch("bg-chat", "chat", "background"));
    render(<ChatLaunchesSlideOut />);
    act(() => {
      applyChatLaunchSnapshot(BINDING, launch("bg-chat", "chat", "background", {
        sequence: 5,
        phase: "completed",
        agentStarted: true,
        stages: [stage("fetch", "done"), stage("checkout", "done"), stage("agent", "done")],
      }));
    });
    expect(screen.getByTestId("chat-launches-headline").textContent).toBe("1 ready");
    act(() => {
      vi.advanceTimersByTime(CHAT_LAUNCH_SLIDE_OUT_AUTO_DISMISS_MS + 10);
    });
    expect(screen.queryByTestId("chat-launches-slide-out")).toBeNull();
  });

  it("keeps a failed launch until it is dismissed with X", () => {
    vi.useFakeTimers();
    applyChatLaunchSnapshot(BINDING, launch("ok", "cli", "background", { phase: "completed", agentStarted: true }));
    applyChatLaunchSnapshot(BINDING, launch("bad", "chat", "background", {
      phase: "failed",
      error: "fetch failed",
      stages: [stage("fetch", "failed"), stage("checkout", "pending"), stage("agent", "pending")],
    }));
    render(<ChatLaunchesSlideOut />);
    expect(screen.getByTestId("chat-launches-headline").textContent).toBe("1 ready · 1 failed");
    act(() => {
      vi.advanceTimersByTime(CHAT_LAUNCH_SLIDE_OUT_AUTO_DISMISS_MS + 10);
    });
    const rows = screen.getAllByTestId("chat-launch-row");
    expect(rows.map((row) => row.getAttribute("data-launch-id"))).toEqual(["bad"]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss launches" }));
    expect(screen.queryByTestId("chat-launches-slide-out")).toBeNull();
  });

  it("summarises the set in its headline", () => {
    expect(slideOutHeadline([launch("a", "cli", "background")])).toBe("Setting up 1 lane…");
    expect(slideOutHeadline([
      launch("a", "cli", "background", { phase: "completed" }),
      launch("b", "cli", "background", { phase: "completed" }),
    ])).toBe("2 ready");
  });

  it("opens a CLI launch's session once it exists", () => {
    applyChatLaunchSnapshot(BINDING, launch("cli", "cli", "background", {
      phase: "failed",
      sessionId: "pty-session-1",
      stages: [stage("checkout", "done"), stage("agent", "failed")],
    }));
    render(<ChatLaunchesSlideOut />);
    fireEvent.click(screen.getByTestId("lane-setup-open"));
    expect(navigateMock).toHaveBeenCalledWith("/work?laneId=lane-cli&sessionId=pty-session-1");
  });
});
