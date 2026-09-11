/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkToolReadOnlyView } from "./WorkToolReadOnlyView";
import type { WorkToolsLaneState } from "../../../shared/types/workTools";

const DATA_URL = "data:image/png;base64,AAAA";

function laneState(overrides: Partial<WorkToolsLaneState> = {}): WorkToolsLaneState {
  return {
    laneId: "lane-1",
    activeTool: "browser",
    openTools: ["browser"],
    activeToolUpdatedAt: "2026-01-01T00:00:00.000Z",
    browser: {
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          title: "Sign in · Example",
          url: "https://example.test/login",
          ownerChatSessionId: "chat-9",
          recording: true,
          active: true,
          handoffReason: null,
        },
      ],
      latestObservation: {
        path: "/tmp/obs/obs-2.png",
        capturedAt: "2026-01-02T00:00:00.000Z",
        caption: "Sign in",
      },
    },
    browserUnavailable: null,
    agentBrowserPresence: [],
    appControl: {
      appName: "ADE Dev",
      status: "connected",
      driver: "cdp",
      latestObservation: null,
    },
    capturedAt: "2026-01-02T00:00:01.000Z",
    ...overrides,
  };
}

function installAde(workTools: Partial<Window["ade"]["workTools"]>): void {
  (window as unknown as { ade: unknown }).ade = { workTools };
}

describe("WorkToolReadOnlyView", () => {
  beforeEach(() => {
    (window as unknown as { ade?: unknown }).ade = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the lane's tabs and the latest frame, and never offers a control", async () => {
    const readObservationPreview = vi.fn(async () => ({
      dataUrl: DATA_URL,
      mimeType: "image/png",
      byteLength: 4,
    }));
    installAde({
      getLaneState: vi.fn(async () => laneState()),
      readObservationPreview,
    });

    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);

    expect(await screen.findByText("Sign in · Example")).toBeTruthy();
    expect(screen.getByText("https://example.test/login")).toBeTruthy();
    expect(screen.getByText("Recording")).toBeTruthy();
    expect(screen.getByText("Control from the desktop")).toBeTruthy();
    // Read-only means read-only: no button, no input, anywhere in the subtree.
    expect(document.querySelectorAll("button, input, textarea, select")).toHaveLength(0);

    await waitFor(() => {
      expect(screen.getByRole("img")).toHaveProperty("src", DATA_URL);
    });
    // Bytes are fetched by path, never carried in the state payload.
    expect(readObservationPreview).toHaveBeenCalledWith("/tmp/obs/obs-2.png");
  });

  it("renders the App Control app and status when asked for that tool", async () => {
    installAde({
      getLaneState: vi.fn(async () => laneState()),
      readObservationPreview: vi.fn(async () => null),
    });

    render(<WorkToolReadOnlyView tool="app-control" laneId="lane-1" />);

    expect(await screen.findByText("ADE Dev")).toBeTruthy();
    expect(screen.getByText("connected · cdp")).toBeTruthy();
    // The browser's tabs belong to the browser card, not this one.
    expect(screen.queryByText("Sign in · Example")).toBeNull();
  });

  it("says where the tools actually run when no desktop is attached", async () => {
    installAde({ getLaneState: vi.fn(async () => null) });

    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);

    expect(
      await screen.findByText("Tools run on the desktop. Open ADE on your Mac to see them here."),
    ).toBeTruthy();
  });

  it("reports an empty browser rather than an error when the desktop has no tabs", async () => {
    installAde({
      getLaneState: vi.fn(async () => laneState({
        browser: { activeTabId: null, tabs: [], latestObservation: null },
      })),
    });

    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);

    expect(await screen.findByText("No browser tabs are open in this lane.")).toBeTruthy();
  });

  it("does not tell a user with ADE already open to open ADE", async () => {
    // The narrow reason: a desktop IS attached, it just has no window for this
    // project. "Open ADE on your Mac" would send them to look at an app that is
    // already in front of them — the exact failure the reason exists to avoid,
    // and the wording is shared with the iOS sheet so the two cannot drift.
    installAde({
      getLaneState: vi.fn(async () => laneState({
        browser: null,
        browserUnavailable: "desktop_not_attached_for_project",
      })),
    });

    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);

    expect(
      await screen.findByText(
        "ADE Desktop doesn't have this project open. Open it on your Mac to see its tabs.",
      ),
    ).toBeTruthy();
  });

  it("distinguishes an unsupported browser from a failed read", async () => {
    installAde({
      getLaneState: vi.fn(async () => laneState({ browser: null, browserUnavailable: "unsupported" })),
    });
    const { unmount } = render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);
    expect(await screen.findByText("The browser isn't available on this machine.")).toBeTruthy();
    unmount();

    installAde({
      getLaneState: vi.fn(async () => laneState({ browser: null, browserUnavailable: "error" })),
    });
    render(<WorkToolReadOnlyView tool="browser" laneId="lane-1" />);
    expect(await screen.findByText("Couldn't read the browser's state.")).toBeTruthy();
  });

  it("asks for nothing without a lane", async () => {
    const getLaneState = vi.fn(async () => laneState());
    installAde({ getLaneState });

    render(<WorkToolReadOnlyView tool="browser" laneId={null} />);

    expect(await screen.findByText("Select a lane to see what its tools are doing.")).toBeTruthy();
    expect(getLaneState).not.toHaveBeenCalled();
  });
});
