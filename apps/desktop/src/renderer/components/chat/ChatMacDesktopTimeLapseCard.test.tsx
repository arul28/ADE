/* @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MacDesktopEventPayload } from "../../../shared/types/macDesktop";
import {
  noteFloatingWorkSurfaceShown,
  noteWorkSurfaceMounted,
  resetWorkToolOnScreenForTests,
  workSurfaceKey,
} from "../../lib/workToolOnScreen";
import { MAC_DESKTOP_CARD_ON_SCREEN_KEY } from "../work/macDesktopCardGrants";
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

  /*
   * Two surfaces already show the lane's desktop live: the tools pane, and the
   * floating player over the chat. While either does, the turn's clip is a
   * second picture of the same screen (the owner's reports of 2026-09-24 and
   * 2026-10-05), so it never pops up and goes away when one appears.
   */
  const SURFACES = [
    ["the tools pane", () => noteWorkSurfaceMounted(workSurfaceKey("mac-desktop", "bound", "lane-1"), document.createElement("div"))],
    ["the floating player", () => noteFloatingWorkSurfaceShown(workSurfaceKey(MAC_DESKTOP_CARD_ON_SCREEN_KEY, "bound", "lane-1"))],
  ] as const;

  /** Lets the clip's source resolve, so an absent card is absent for its own reason. */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it.each(SURFACES)("never pops up while %s shows the lane's desktop, and does not pop up after", async (_label, show) => {
    const hide = show();
    mount();
    emitTimeLapse();
    await settle();
    expect(screen.queryByTestId("mac-desktop-time-lapse")).toBeNull();

    // The clip that arrived meanwhile is not saved for later.
    act(() => hide());
    await settle();
    expect(screen.queryByTestId("mac-desktop-time-lapse")).toBeNull();
  });

  it.each(SURFACES)("goes away when %s starts showing the lane's desktop", async (_label, show) => {
    mount();
    emitTimeLapse();
    await waitFor(() => expect(screen.getByTestId("mac-desktop-time-lapse")).toBeTruthy());
    act(() => {
      show();
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
