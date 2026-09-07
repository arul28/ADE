import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppControlStatus, BuiltInBrowserStatus } from "../../../../desktop/src/shared/types";
import { createWorkToolsStateService } from "./workToolsStateService";

/** A 1x1 PNG. Enough for the preview reader to accept and encode. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function browserStatus(overrides: Partial<BuiltInBrowserStatus> = {}): BuiltInBrowserStatus {
  return {
    attached: true,
    partition: "persist:ade",
    storageProfileKey: "global",
    collectionKey: "project",
    collectionProjectRoot: null,
    persistentProfile: true,
    visible: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    activeTabId: "tab-1",
    tabs: [],
    url: null,
    title: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isInspecting: false,
    hasSelection: false,
    ownerLaneId: null,
    ownerChatSessionId: null,
    ownerClaimedAt: null,
    ownerLeaseExpiresAt: null,
    ...overrides,
  } as BuiltInBrowserStatus;
}

function tab(overrides: Partial<BuiltInBrowserStatus["tabs"][number]> = {}): BuiltInBrowserStatus["tabs"][number] {
  return {
    id: "tab-1",
    url: "https://example.test/",
    title: "Example",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    ownerLaneId: null,
    ownerChatSessionId: null,
    ownerClaimedAt: null,
    ownerLeaseExpiresAt: null,
    zoomFactor: 1,
    devToolsOpen: false,
    emulation: null,
    networkLogging: false,
    recording: null,
    ...overrides,
  } as BuiltInBrowserStatus["tabs"][number];
}

function appControlStatus(session: Partial<NonNullable<AppControlStatus["activeSession"]>> | null): AppControlStatus {
  return {
    platform: process.platform,
    supported: true,
    providers: [],
    activeSession: session
      ? ({
        id: "sess-1",
        appKind: "electron",
        label: "ADE Dev",
        projectRoot: null,
        laneId: null,
        cwd: null,
        command: null,
        pid: 1,
        terminalSessionId: null,
        terminalPtyId: null,
        cdpPort: 9222,
        cdpEndpoint: null,
        cdpTargetId: null,
        provider: "cdp",
        driver: "cdp",
        chatSessionId: null,
        startedAt: new Date().toISOString(),
        connectedAt: null,
        status: "connected",
        lastError: null,
        lastObservationId: null,
        lastTraceEntryId: null,
        ...session,
      } as NonNullable<AppControlStatus["activeSession"]>)
      : null,
  } as AppControlStatus;
}

describe("workToolsStateService", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-work-tools-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeObservation(args: {
    kind: "browser" | "app-control";
    id: string;
    capturedAt: string;
    ownerLaneId?: string | null;
    title?: string | null;
  }): string {
    const root = path.join(
      projectRoot,
      ".ade",
      "cache",
      args.kind === "browser" ? "browser-observations" : "app-control-observations",
      "collection",
    );
    fs.mkdirSync(root, { recursive: true });
    const imagePath = path.join(root, `${args.id}.png`);
    fs.writeFileSync(imagePath, PNG_BYTES);
    fs.writeFileSync(
      path.join(root, `${args.id}.json`),
      JSON.stringify({
        id: args.id,
        capturedAt: args.capturedAt,
        filePath: imagePath,
        title: args.title ?? "Example",
        url: "https://example.test/",
        ownerLaneId: args.ownerLaneId ?? null,
      }),
      "utf8",
    );
    return imagePath;
  }

  it("summarizes the desktop's tabs when a browser bridge answers", async () => {
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => browserStatus({
        activeTabId: "tab-1",
        tabs: [
          tab({ id: "tab-1", ownerChatSessionId: "chat-9", recording: { startedAt: "now", fps: 30 } }),
          // Claimed by a different lane: belongs to that lane's pane, not ours.
          tab({ id: "tab-2", ownerLaneId: "lane-other", title: "Other" }),
          tab({ id: "tab-3", ownerLaneId: "lane-1", title: "Mine" }),
        ],
      }),
    });

    const state = await service.getLaneState({ laneId: "lane-1" });

    expect(state.browserUnavailable).toBeNull();
    expect(state.browser?.tabs.map((entry) => entry.id)).toEqual(["tab-1", "tab-3"]);
    expect(state.browser?.tabs[0]).toMatchObject({
      title: "Example",
      url: "https://example.test/",
      ownerChatSessionId: "chat-9",
      recording: true,
      active: true,
    });
    service.dispose();
  });

  it("reports absence, not failure, when no desktop is attached", async () => {
    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => {
        throw new Error("No ADE Desktop browser is attached to this machine");
      },
      getAppControlStatus: () => appControlStatus({ label: "ADE Dev", status: "connected" }),
    });

    const state = await service.getLaneState({ laneId: "lane-1" });

    expect(state.browser).toBeNull();
    expect(state.browserUnavailable).toBe("desktop_not_attached");
    // App Control runs in the daemon, so it survives a desktop that has quit.
    expect(state.appControl).toMatchObject({ appName: "ADE Dev", status: "connected", driver: "cdp" });
    service.dispose();
  });

  it("omits the browser entirely on a runtime with no bridge", async () => {
    const service = createWorkToolsStateService({ projectRoot });
    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.browser).toBeNull();
    expect(state.browserUnavailable).toBe("desktop_not_attached");
    expect(state.appControl).toBeNull();
    service.dispose();
  });

  it("holds the desktop's active tool per lane and coalesces rapid changes into one event", async () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 250 });

    service.setActiveTool({ laneId: "lane-1", tool: "git" });
    service.setActiveTool({ laneId: "lane-1", tool: "files" });
    service.setActiveTool({ laneId: "lane-1", tool: "browser" });
    expect(onStateChanged).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
    expect(onStateChanged).toHaveBeenCalledWith("lane-1");

    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.activeTool).toBe("browser");
    expect(state.activeToolUpdatedAt).toBeTruthy();

    // A different lane is its own debounce window.
    service.setActiveTool({ laneId: "lane-2", tool: "ios" });
    vi.advanceTimersByTime(250);
    expect(onStateChanged).toHaveBeenCalledTimes(2);
    expect(onStateChanged).toHaveBeenLastCalledWith("lane-2");
    expect((await service.getLaneState({ laneId: "lane-1" })).activeTool).toBe("browser");
    service.dispose();
  });

  it("does not emit when the desktop re-publishes the tool it already published", () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 10 });

    service.setActiveTool({ laneId: "lane-1", tool: "browser" });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // Reconnect re-publish: same value, so nothing changed for any client.
    service.setActiveTool({ laneId: "lane-1", tool: "browser" });
    vi.advanceTimersByTime(10);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("rejects an unknown tool rather than storing it", () => {
    const service = createWorkToolsStateService({ projectRoot });
    expect(() => service.setActiveTool({ laneId: "lane-1", tool: "nope" as never })).toThrow(/unknown tool/);
    service.dispose();
  });

  it("requires a lane id", async () => {
    const service = createWorkToolsStateService({ projectRoot });
    expect(() => service.setActiveTool({ laneId: "  ", tool: null })).toThrow(/requires laneId/);
    await expect(service.getLaneState({ laneId: "" })).rejects.toThrow(/requires laneId/);
    service.dispose();
  });

  it("reports the newest observation for the lane and serves its bytes separately", async () => {
    writeObservation({ kind: "browser", id: "obs-1", capturedAt: "2026-01-01T00:00:00.000Z" });
    const newest = writeObservation({
      kind: "browser",
      id: "obs-2",
      capturedAt: "2026-01-02T00:00:00.000Z",
      ownerLaneId: "lane-1",
      title: "Sign in",
    });
    // Another lane's capture must not leak into this lane's pane.
    writeObservation({
      kind: "browser",
      id: "obs-3",
      capturedAt: "2026-01-03T00:00:00.000Z",
      ownerLaneId: "lane-other",
    });

    const service = createWorkToolsStateService({
      projectRoot,
      getBrowserStatus: async () => browserStatus({ tabs: [tab()] }),
    });

    const state = await service.getLaneState({ laneId: "lane-1" });
    expect(state.browser?.latestObservation).toEqual({
      path: newest,
      capturedAt: "2026-01-02T00:00:00.000Z",
      caption: "Sign in",
    });
    // The state carried a path, never bytes.
    expect(JSON.stringify(state)).not.toContain("base64");

    const preview = await service.readObservationPreview({ path: newest });
    expect(preview?.mimeType).toBe("image/png");
    expect(preview?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    service.dispose();
  });

  it("refuses to read a path outside the observation caches", async () => {
    const outside = path.join(projectRoot, "secret.png");
    fs.writeFileSync(outside, PNG_BYTES);
    const service = createWorkToolsStateService({ projectRoot });
    await expect(service.readObservationPreview({ path: outside })).resolves.toBeNull();
    service.dispose();
  });

  it("refuses a non-image observation path even inside the cache", async () => {
    const root = path.join(projectRoot, ".ade", "cache", "browser-observations");
    fs.mkdirSync(root, { recursive: true });
    const notAnImage = path.join(root, "notes.txt");
    fs.writeFileSync(notAnImage, "hello");
    const service = createWorkToolsStateService({ projectRoot });
    await expect(service.readObservationPreview({ path: notAnImage })).resolves.toBeNull();
    service.dispose();
  });

  it("stops emitting after dispose", () => {
    vi.useFakeTimers();
    const onStateChanged = vi.fn();
    const service = createWorkToolsStateService({ projectRoot, onStateChanged, debounceMs: 10 });
    service.setActiveTool({ laneId: "lane-1", tool: "git" });
    service.dispose();
    vi.advanceTimersByTime(50);
    expect(onStateChanged).not.toHaveBeenCalled();
  });
});
