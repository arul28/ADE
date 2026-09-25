/* @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MacDesktopEventPayload } from "../../../shared/types/macDesktop";
import { noteWorkSurfaceMounted, resetWorkToolOnScreenForTests, workSurfaceKey } from "../../lib/workToolOnScreen";
import { ChatMacDesktopTimeLapseCard, resolveMacDesktopTimeLapseSrc } from "./ChatMacDesktopTimeLapseCard";
import type { OpenProjectBinding } from "../../../shared/types";

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
    return render(<ChatMacDesktopTimeLapseCard laneId="lane-1" sessionId="chat-1" runtimePin={null} workScopeKey="bound" />);
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

const ROOT = "/Users/me/project";
const CLIP = `${ROOT}/.ade/artifacts/computer-use/mac-desktop-turn-t1.mp4`;
const BASE = "http://127.0.0.1:5123/token";
const localPin = { kind: "local", key: "k", rootPath: ROOT, displayName: "project" } as OpenProjectBinding;
const remotePin = {
  kind: "remote",
  key: "k",
  targetId: "mac-2",
  projectId: "p",
  rootPath: "/Users/other/project",
  displayName: "project",
} as unknown as OpenProjectBinding;

describe("resolveMacDesktopTimeLapseSrc", () => {
  it("plays the clip from the loopback media server, not ade-artifact://", async () => {
    const readArtifactPreview = vi.fn(async () => "data:video/mp4;base64,AAAA");
    const src = await resolveMacDesktopTimeLapseSrc({
      filePath: CLIP,
      rootPath: ROOT,
      pin: localPin,
      webClient: false,
      mediaBaseUrl: async () => BASE,
      readArtifactPreview,
    });
    expect(src).toBe(`${BASE}/project/.ade/artifacts/computer-use/mac-desktop-turn-t1.mp4?root=${encodeURIComponent(ROOT)}`);
    expect(readArtifactPreview).not.toHaveBeenCalled();
  });

  it("falls back to the host's preview read when there is no server, as the proof drawer does", async () => {
    const readArtifactPreview = vi.fn(async () => "data:video/quicktime;base64,AAAA");
    const src = await resolveMacDesktopTimeLapseSrc({
      filePath: CLIP,
      rootPath: ROOT,
      pin: null,
      webClient: false,
      mediaBaseUrl: async () => null,
      readArtifactPreview,
    });
    // Chromium refuses `video/quicktime`; the same bytes play as mp4.
    expect(src).toBe("data:video/mp4;base64,AAAA");
    expect(readArtifactPreview).toHaveBeenCalledWith({ uri: CLIP }, null);
  });

  it("reads a paired machine's clip through the pin, never this computer's server", async () => {
    const mediaBaseUrl = vi.fn(async () => BASE);
    const readArtifactPreview = vi.fn(async () => "data:video/mp4;base64,BBBB");
    const src = await resolveMacDesktopTimeLapseSrc({
      filePath: "/Users/other/project/.ade/artifacts/clip.mp4",
      rootPath: "/Users/other/project",
      pin: remotePin,
      webClient: false,
      mediaBaseUrl,
      readArtifactPreview,
    });
    expect(src).toBe("data:video/mp4;base64,BBBB");
    expect(mediaBaseUrl).not.toHaveBeenCalled();
    expect(readArtifactPreview).toHaveBeenCalledWith({ uri: "/Users/other/project/.ade/artifacts/clip.mp4" }, remotePin);
  });

  it("answers null when neither path has the bytes, so the card shows nothing", async () => {
    const src = await resolveMacDesktopTimeLapseSrc({
      filePath: "/elsewhere/clip.mp4",
      rootPath: ROOT,
      pin: localPin,
      webClient: false,
      mediaBaseUrl: async () => BASE,
      readArtifactPreview: async () => null,
    });
    expect(src).toBeNull();
  });
});
