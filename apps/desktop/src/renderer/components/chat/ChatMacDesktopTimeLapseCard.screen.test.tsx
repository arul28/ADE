/* @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MacDesktopEventPayload } from "../../../shared/types/macDesktop";
import {
  noteWorkSurfaceMounted,
  resetWorkToolOnScreenForTests,
  workSurfaceKey,
} from "../../lib/workToolOnScreen";
import { ChatMacDesktopTimeLapseCard } from "./ChatMacDesktopTimeLapseCard";

let listeners: Array<(event: MacDesktopEventPayload) => void> = [];

function emitTimeLapse(): void {
  const event = {
    type: "time-lapse",
    timeLapse: {
      laneId: "lane-1",
      chatSessionId: "chat-1",
      filePath: "/Users/me/project/.ade/artifacts/computer-use/turn.mp4",
      durationMs: 4_000,
    },
  } as unknown as MacDesktopEventPayload;
  act(() => {
    for (const listener of listeners) listener(event);
  });
}

describe("ChatMacDesktopTimeLapseCard next to the pane", () => {
  beforeEach(() => {
    resetWorkToolOnScreenForTests();
    listeners = [];
    (window as unknown as { ade: unknown }).ade = {
      macDesktop: {
        onEvent: vi.fn((listener: (event: MacDesktopEventPayload) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((entry) => entry !== listener);
          };
        }),
      },
      computerUse: {
        mediaBaseUrl: vi.fn(async () => "http://127.0.0.1:5123/token"),
        readArtifactPreview: vi.fn(async () => "data:video/mp4;base64,AAAA"),
      },
    };
  });

  afterEach(() => {
    cleanup();
    resetWorkToolOnScreenForTests();
  });

  function mount() {
    return render(<ChatMacDesktopTimeLapseCard laneId="lane-1" sessionId="chat-1" runtimePin={null} />);
  }

  it("shows the turn's clip while the pane is not showing the lane's desktop", async () => {
    mount();
    emitTimeLapse();
    await waitFor(() => expect(screen.getByTestId("mac-desktop-time-lapse")).toBeTruthy());
  });

  it("regression: never pops up while the tools pane shows the lane's Mac Desktop", async () => {
    // The owner's 2026-09-24 report: the agent finished, and a second picture
    // of the desktop popped up in the thread next to the open pane.
    const pane = document.createElement("div");
    const unmount = noteWorkSurfaceMounted(workSurfaceKey("mac-desktop", "bound", "lane-1"), pane);
    mount();
    emitTimeLapse();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("mac-desktop-time-lapse")).toBeNull();

    // The clip that arrived while the pane showed the desktop is not saved
    // for later: closing the pane does not pop it up after the fact.
    act(() => unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("mac-desktop-time-lapse")).toBeNull();
  });

  it("goes away when the pane opens on the lane's desktop", async () => {
    mount();
    emitTimeLapse();
    await waitFor(() => expect(screen.getByTestId("mac-desktop-time-lapse")).toBeTruthy());
    act(() => {
      noteWorkSurfaceMounted(workSurfaceKey("mac-desktop", "bound", "lane-1"), document.createElement("div"));
    });
    await waitFor(() => expect(screen.queryByTestId("mac-desktop-time-lapse")).toBeNull());
  });
});
